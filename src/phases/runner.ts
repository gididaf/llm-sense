import { access } from 'node:fs/promises';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import chalk from 'chalk';
import { isClaudeInstalled } from '../core/claude.js';
import { getPreviousScore, saveHistory } from '../core/history.js';
import { runStaticAnalysis } from './staticAnalysis.js';
import { runLlmUnderstanding } from './llmUnderstanding.js';
import { runTaskGeneration } from './taskGeneration.js';
import { runEmpiricalTesting } from './empiricalTesting.js';
import { computeScores } from './scoring.js';
import { generateReport, buildExecutableRecommendations } from '../report/generator.js';
import { cleanupAll } from '../core/isolation.js';
import type { CliOptions, CodebaseUnderstanding, TaskGenerationResponse, TaskExecutionResult, FinalReport } from '../types.js';

export async function run(options: CliOptions): Promise<void> {
  const startTime = Date.now();
  let totalCostUsd = 0;

  console.log('');
  console.log(chalk.bold('  llm-sense') + ' — Analyzing LLM-friendliness');
  console.log(chalk.dim(`  Target: ${options.path}`));
  console.log('');

  // Pre-flight checks
  try {
    await access(options.path);
  } catch {
    console.error(chalk.red(`  Error: Path not found: ${options.path}`));
    process.exit(1);
  }

  if (!options.skipEmpirical) {
    const claudeOk = await isClaudeInstalled();
    if (!claudeOk) {
      console.error(chalk.red('  Error: Claude Code CLI not found.'));
      console.error(chalk.dim('  Install it from https://claude.ai/code'));
      process.exit(1);
    }
  }

  // Load previous score for delta display
  const previousScore = await getPreviousScore(options.path);

  // Phase 1: Static Analysis
  console.log(chalk.yellow('Phase 1:') + ' Static Analysis');
  const { result: staticResult, entries } = await runStaticAnalysis(options.path, options.verbose);
  console.log(chalk.green('  ✓') + ` ${staticResult.fileSizes.totalFiles} source files, ${staticResult.fileSizes.totalLines.toLocaleString()} lines analyzed`);
  console.log('');

  let understanding: CodebaseUnderstanding | null = null;
  let tasks: TaskGenerationResponse | null = null;
  let taskResults: TaskExecutionResult[] = [];

  if (!options.skipEmpirical) {
    // Phase 2: LLM Understanding
    console.log(chalk.yellow('Phase 2:') + ' LLM Codebase Understanding');
    try {
      const phase2 = await runLlmUnderstanding(
        options.path, entries, staticResult, options.verbose, options.model,
      );
      understanding = phase2.data;
      totalCostUsd += phase2.costUsd;
      console.log(chalk.green('  ✓') + ` ${understanding.projectName} — ${understanding.complexity} complexity, ${understanding.techStack.length} technologies`);
      console.log(chalk.dim(`    Cost: $${phase2.costUsd.toFixed(2)}, Duration: ${(phase2.durationMs / 1000).toFixed(0)}s`));
    } catch (error) {
      console.log(chalk.red('  ✗') + ` Failed: ${error instanceof Error ? error.message : error}`);
      console.log(chalk.dim('    Continuing with static-only scoring...'));
    }
    console.log('');

    // Phase 3: Task Generation (only if Phase 2 succeeded)
    if (understanding) {
      console.log(chalk.yellow('Phase 3:') + ' Synthetic Task Generation');
      try {
        const phase3 = await runTaskGeneration(
          options.path, entries, understanding,
          options.bugs, options.features, options.verbose, options.model,
        );
        tasks = phase3.data;
        totalCostUsd += phase3.costUsd;
        console.log(chalk.green('  ✓') + ` Generated ${tasks.bugs.length} bugs + ${tasks.features.length} features`);
        console.log(chalk.dim(`    Cost: $${phase3.costUsd.toFixed(2)}, Duration: ${(phase3.durationMs / 1000).toFixed(0)}s`));
      } catch (error) {
        console.log(chalk.red('  ✗') + ` Failed: ${error instanceof Error ? error.message : error}`);
        console.log(chalk.dim('    Continuing without empirical testing...'));
      }
      console.log('');
    }

    // Phase 4: Empirical Testing (only if Phase 3 succeeded)
    if (tasks) {
      const allTasks = [...tasks.bugs, ...tasks.features];
      console.log(chalk.yellow('Phase 4:') + ` Empirical Testing (${allTasks.length} tasks)`);
      console.log('');

      try {
        const phase4 = await runEmpiricalTesting(
          options.path, allTasks,
          options.maxTurnsPerTask, options.maxBudgetPerTask,
          options.verbose, options.model,
        );
        taskResults = phase4.results;
        totalCostUsd += phase4.totalCostUsd;
        const successCount = taskResults.filter(r => r.success).length;
        console.log('');
        console.log(chalk.green('  ✓') + ` ${successCount}/${taskResults.length} tasks completed successfully`);
        console.log(chalk.dim(`    Cost: $${phase4.totalCostUsd.toFixed(2)}, Duration: ${(phase4.totalDurationMs / 1000).toFixed(0)}s`));
      } catch (error) {
        console.log(chalk.red('  ✗') + ` Failed: ${error instanceof Error ? error.message : error}`);
      } finally {
        await cleanupAll();
      }
      console.log('');
    }
  }

  // Phase 5: Scoring — uses different weight distributions for static-only vs full empirical.
  // When empirical is skipped (or failed), Task Completion and Token Efficiency are excluded
  // and their weights redistributed to static categories.
  const skipEmpirical = options.skipEmpirical || taskResults.length === 0;
  console.log(chalk.yellow('Phase 5:') + ' Scoring');
  const { categories, overallScore, grade } = computeScores(staticResult, taskResults, skipEmpirical);

  let scoreMsg = `Overall score: ${chalk.bold(`${overallScore}/100`)} (Grade: ${chalk.bold(grade)})`;
  if (previousScore !== null) {
    const delta = overallScore - previousScore;
    const deltaColor = delta >= 0 ? chalk.green : chalk.red;
    scoreMsg += deltaColor(` [was ${previousScore}, ${delta >= 0 ? '+' : ''}${delta}]`);
  }
  console.log(chalk.green('  ✓') + ` ${scoreMsg}`);
  console.log('');

  // Build executable recommendations
  const recommendations = buildExecutableRecommendations(categories, staticResult, understanding);

  // Phase 6: Report Generation
  const totalDurationMs = Date.now() - startTime;
  const report: FinalReport = {
    overallScore,
    grade,
    categories,
    staticAnalysis: staticResult,
    understanding,
    tasks,
    taskResults,
    recommendations,
    previousScore,
    totalCostUsd,
    totalDurationMs,
    generatedAt: new Date().toISOString(),
    targetPath: options.path,
  };

  console.log(chalk.yellow('Phase 6:') + ' Report Generation');
  const reportContent = generateReport(report);
  const outputPath = resolve(options.output);
  await writeFile(outputPath, reportContent, 'utf-8');
  console.log(chalk.green('  ✓') + ` Report saved to ${chalk.underline(outputPath)}`);
  if (recommendations.length > 0) {
    console.log(chalk.dim(`    ${recommendations.length} improvement tasks generated`));
  }
  console.log('');

  // Save to history
  const categoryScores: Record<string, number> = {};
  for (const cat of categories) {
    categoryScores[cat.name] = cat.score;
  }
  await saveHistory(options.path, {
    timestamp: new Date().toISOString(),
    overallScore,
    grade,
    categoryScores,
    targetPath: options.path,
    costUsd: totalCostUsd,
  });

  // Summary
  console.log(chalk.bold('  Results'));
  console.log(`  Score: ${overallScore}/100 (${grade})`);
  console.log(`  Cost:  $${totalCostUsd.toFixed(2)}`);
  console.log(`  Time:  ${formatDuration(totalDurationMs)}`);
  console.log(`  Tasks: ${recommendations.length} improvements`);
  console.log('');

  // Quick category summary
  for (const cat of categories.sort((a, b) => a.score - b.score)) {
    const bar = scoreBar(cat.score);
    console.log(`  ${bar} ${cat.score.toString().padStart(3)} ${cat.name}`);
  }
  console.log('');
}

function scoreBar(score: number): string {
  const filled = Math.round(score / 5);
  const empty = 20 - filled;
  const color = score >= 70 ? chalk.green : score >= 50 ? chalk.yellow : chalk.red;
  return color('█'.repeat(filled)) + chalk.dim('░'.repeat(empty));
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(0)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}
