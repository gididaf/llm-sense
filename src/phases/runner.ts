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
import { generatePlan } from '../report/recommendations.js';
import { buildJsonOutput, formatSummary } from '../report/jsonOutput.js';
import { writeBadge } from '../report/badge.js';
import { buildComparison, formatComparisonMarkdown, formatComparisonJson, type ComparisonRepo } from '../report/comparison.js';
import { runAutoFix, formatFixResults } from './autoFix.js';
import { cleanupAll } from '../core/isolation.js';
import type { CliOptions, CodebaseUnderstanding, TaskGenerationResponse, TaskExecutionResult, FinalReport } from '../types.js';

export async function run(options: CliOptions): Promise<void> {
  const startTime = Date.now();
  let totalCostUsd = 0;

  // When outputting JSON or summary, route all progress to stderr
  // so stdout contains only the machine-readable output
  const isQuietStdout = options.format === 'json' || options.format === 'summary';
  const log = isQuietStdout
    ? (...args: unknown[]) => console.error(...args)
    : console.log;

  log('');
  log(chalk.bold('  llm-sense') + ' — Analyzing LLM-friendliness');
  log(chalk.dim(`  Target: ${options.path}`));
  log('');

  // Pre-flight checks
  try {
    await access(options.path);
  } catch {
    console.error(chalk.red(`  Error: Path not found: ${options.path}`));
    process.exit(2);
  }

  if (!options.skipEmpirical || options.fix) {
    const claudeOk = await isClaudeInstalled();
    if (!claudeOk) {
      console.error(chalk.red('  Error: Claude Code CLI not found.'));
      console.error(chalk.dim('  Install it from https://claude.ai/code'));
      process.exit(2);
    }
  }

  // Load previous score for delta display
  const previousScore = await getPreviousScore(options.path);

  // Phase 1: Static Analysis
  log(chalk.yellow('Phase 1:') + ' Static Analysis');
  const { result: staticResult, entries } = await runStaticAnalysis(options.path, options.verbose);
  log(chalk.green('  ✓') + ` ${staticResult.fileSizes.totalFiles} source files, ${staticResult.fileSizes.totalLines.toLocaleString()} lines analyzed`);
  log('');

  let understanding: CodebaseUnderstanding | null = null;
  let tasks: TaskGenerationResponse | null = null;
  let taskResults: TaskExecutionResult[] = [];

  if (!options.skipEmpirical) {
    // Phase 2: LLM Understanding
    log(chalk.yellow('Phase 2:') + ' LLM Codebase Understanding');
    try {
      const phase2 = await runLlmUnderstanding(
        options.path, entries, staticResult, options.verbose, options.model,
      );
      understanding = phase2.data;
      totalCostUsd += phase2.costUsd;
      log(chalk.green('  ✓') + ` ${understanding.projectName} — ${understanding.complexity} complexity, ${understanding.techStack.length} technologies`);
      log(chalk.dim(`    Cost: $${phase2.costUsd.toFixed(2)}, Duration: ${(phase2.durationMs / 1000).toFixed(0)}s`));
    } catch (error) {
      log(chalk.red('  ✗') + ` Failed: ${error instanceof Error ? error.message : error}`);
      log(chalk.dim('    Continuing with static-only scoring...'));
    }
    log('');

    // Phase 3: Task Generation (only if Phase 2 succeeded)
    if (understanding) {
      log(chalk.yellow('Phase 3:') + ' Synthetic Task Generation');
      try {
        const phase3 = await runTaskGeneration(
          options.path, entries, understanding,
          options.bugs, options.features, options.verbose, options.model,
        );
        tasks = phase3.data;
        totalCostUsd += phase3.costUsd;
        log(chalk.green('  ✓') + ` Generated ${tasks.bugs.length} bugs + ${tasks.features.length} features`);
        log(chalk.dim(`    Cost: $${phase3.costUsd.toFixed(2)}, Duration: ${(phase3.durationMs / 1000).toFixed(0)}s`));
      } catch (error) {
        log(chalk.red('  ✗') + ` Failed: ${error instanceof Error ? error.message : error}`);
        log(chalk.dim('    Continuing without empirical testing...'));
      }
      log('');
    }

    // Phase 4: Empirical Testing (only if Phase 3 succeeded)
    if (tasks) {
      const allTasks = [...tasks.bugs, ...tasks.features];
      log(chalk.yellow('Phase 4:') + ` Empirical Testing (${allTasks.length} tasks)`);
      log('');

      try {
        const phase4 = await runEmpiricalTesting(
          options.path, allTasks,
          options.maxTurnsPerTask, options.maxBudgetPerTask,
          options.verbose, options.model, options.concurrency,
        );
        taskResults = phase4.results;
        totalCostUsd += phase4.totalCostUsd;
        const successCount = taskResults.filter(r => r.success).length;
        log('');
        log(chalk.green('  ✓') + ` ${successCount}/${taskResults.length} tasks completed successfully`);
        log(chalk.dim(`    Cost: $${phase4.totalCostUsd.toFixed(2)}, Duration: ${(phase4.totalDurationMs / 1000).toFixed(0)}s`));
      } catch (error) {
        log(chalk.red('  ✗') + ` Failed: ${error instanceof Error ? error.message : error}`);
      } finally {
        await cleanupAll();
      }
      log('');
    }
  }

  // Phase 5: Scoring
  const skipEmpirical = options.skipEmpirical || taskResults.length === 0;
  log(chalk.yellow('Phase 5:') + ' Scoring');
  const { categories, overallScore, grade } = computeScores(staticResult, taskResults, skipEmpirical);

  let scoreMsg = `Overall score: ${chalk.bold(`${overallScore}/100`)} (Grade: ${chalk.bold(grade)})`;
  if (previousScore !== null) {
    const delta = overallScore - previousScore;
    const deltaColor = delta >= 0 ? chalk.green : chalk.red;
    scoreMsg += deltaColor(` [was ${previousScore}, ${delta >= 0 ? '+' : ''}${delta}]`);
  }
  log(chalk.green('  ✓') + ` ${scoreMsg}`);
  log('');

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

  log(chalk.yellow('Phase 6:') + ' Report Generation');

  // Output based on format (skip JSON/summary stdout if --compare will output its own)
  if (options.format === 'json' && !options.compare) {
    const jsonOutput = buildJsonOutput(report, skipEmpirical ? 'static-only' : 'full', options.model);
    process.stdout.write(JSON.stringify(jsonOutput, null, 2) + '\n');
    log(chalk.green('  ✓') + ' JSON output written to stdout');
  } else if (options.format === 'summary' && !options.compare) {
    process.stdout.write(formatSummary(report) + '\n');
    log(chalk.green('  ✓') + ' Summary written to stdout');
  } else if (options.format === 'json' || options.format === 'summary') {
    log(chalk.green('  ✓') + ' Comparison output follows');
  } else {
    // markdown (default) — write report file
    const reportContent = generateReport(report);
    const outputPath = resolve(options.output);
    await writeFile(outputPath, reportContent, 'utf-8');
    log(chalk.green('  ✓') + ` Report saved to ${chalk.underline(outputPath)}`);
    if (recommendations.length > 0) {
      log(chalk.dim(`    ${recommendations.length} improvement tasks generated`));
    }
  }

  // Badge generation (works with any format)
  if (options.badge) {
    const badgePath = await writeBadge(overallScore, options.badge);
    log(chalk.green('  ✓') + ` Badge saved to ${chalk.underline(badgePath)}`);
  }

  log('');

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
  log(chalk.bold('  Results'));
  log(`  Score: ${overallScore}/100 (${grade})`);
  log(`  Cost:  $${totalCostUsd.toFixed(2)}`);
  log(`  Time:  ${formatDuration(totalDurationMs)}`);
  log(`  Tasks: ${recommendations.length} improvements`);
  log('');

  // Quick category summary
  for (const cat of categories.sort((a, b) => a.score - b.score)) {
    const bar = scoreBar(cat.score);
    log(`  ${bar} ${cat.score.toString().padStart(3)} ${cat.name}`);
  }
  log('');

  // Improvement plan (--plan flag)
  if (options.plan) {
    log(generatePlan(recommendations, overallScore, options.path));
  }

  // Comparative report (--compare flag)
  if (options.compare) {
    log(chalk.yellow('  Comparing with:') + ` ${options.compare}`);
    try {
      await access(options.compare);
      const { result: compareStatic } = await runStaticAnalysis(options.compare, false);
      const { categories: compareCats, overallScore: compareScore, grade: compareGrade } = computeScores(compareStatic, [], true);

      const repoA: ComparisonRepo = {
        path: options.path,
        name: options.path.split('/').pop() ?? 'repo-a',
        overallScore,
        grade,
        categories,
      };
      const repoB: ComparisonRepo = {
        path: options.compare,
        name: options.compare.split('/').pop() ?? 'repo-b',
        overallScore: compareScore,
        grade: compareGrade,
        categories: compareCats,
      };

      const comparison = buildComparison(repoA, repoB);

      if (options.format === 'json') {
        process.stdout.write(JSON.stringify(formatComparisonJson(comparison), null, 2) + '\n');
      } else {
        log(formatComparisonMarkdown(comparison));
      }
    } catch (error) {
      log(chalk.red(`  Compare path error: ${error instanceof Error ? error.message : error}`));
    }
    log('');
  }

  // Phase 7: Auto-Fix (--fix flag)
  if (options.fix && recommendations.length > 0) {
    log(chalk.yellow('Phase 7:') + ' Auto-Fix');
    const fixResults = await runAutoFix(options, recommendations, overallScore, log);
    formatFixResults(fixResults, log);

    const fixCost = fixResults.reduce((s, r) => s + r.costUsd, 0);
    totalCostUsd += fixCost;
  }

  // Interactive mode (--interactive / -i)
  if (options.interactive) {
    const { runInteractive } = await import('../interactive.js');
    await runInteractive(report, recommendations, options);
  }

  // Min-score threshold check (must be after all output is written)
  if (options.minScore !== undefined && overallScore < options.minScore) {
    log(chalk.red(`  ✗ Score ${overallScore} is below minimum threshold of ${options.minScore}`));
    process.exit(1);
  }
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
