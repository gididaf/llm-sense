import { access } from 'node:fs/promises';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import chalk from 'chalk';
import { isClaudeInstalled } from '../core/claude.js';
import { getPreviousScore, saveHistory } from '../core/history.js';
import { runStaticAnalysis } from './staticAnalysis.js';
import { runLlmUnderstanding, runLlmVerification } from './llmUnderstanding.js';
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

  // Monorepo detection
  if (!options.noMonorepo) {
    const { detectMonorepo } = await import('../core/monorepo.js');
    const { isMonorepo, packages } = await detectMonorepo(options.path);

    if ((isMonorepo && !options.noMonorepo) || options.monorepo) {
      if (packages.length >= 2) {
        log(chalk.bold('  Monorepo detected') + ` — ${packages.length} packages found`);
        log('');
        await runMonorepo(options, packages, log);
        return;
      } else if (options.monorepo) {
        log(chalk.dim('  --monorepo flag set but only 1 package found. Running whole-repo analysis.'));
        log('');
      }
    }
  }

  // Load previous score for delta display
  const previousScore = await getPreviousScore(options.path);

  // Phase 1: Static Analysis (with incremental cache check)
  log(chalk.yellow('Phase 1:') + ' Static Analysis');
  const { walkDir } = await import('../core/fs.js');
  const rawEntries = await walkDir(options.path);

  // Check cache — if valid, we still re-run analyzers (full re-run strategy)
  // but we save the manifest for future runs
  if (!options.noCache) {
    const { checkCache } = await import('../core/cache.js');
    const { cacheHit } = await checkCache(options.path, rawEntries);
    if (cacheHit && options.verbose) {
      log(chalk.dim('  Cache valid — file tree unchanged since last run'));
    }
  }

  const { result: staticResult, entries } = await runStaticAnalysis(options.path, options.verbose);
  log(chalk.green('  ✓') + ` ${staticResult.fileSizes.totalFiles} source files, ${staticResult.fileSizes.totalLines.toLocaleString()} lines analyzed`);
  log('');

  let understanding: CodebaseUnderstanding | null = null;
  let tasks: TaskGenerationResponse | null = null;
  let taskResults: TaskExecutionResult[] = [];
  let llmAdjustments: import('../types.js').LlmVerificationAdjustments | null = null;

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

    // Phase 2b: LLM Verification (validates static findings)
    log(chalk.yellow('Phase 2b:') + ' LLM Verification');
    try {
      const phase2b = await runLlmVerification(
        options.path, entries, staticResult, options.verbose, options.model,
      );
      llmAdjustments = phase2b.adjustments;
      totalCostUsd += phase2b.costUsd;
      const v = phase2b.verification;
      log(chalk.green('  ✓') + ` Doc: ${v.documentationQuality.score}/10, Naming: ${v.namingClarity.score}/10, Architecture: ${v.architectureClarity.score}/10`);
      log(chalk.dim(`    Cost: $${phase2b.costUsd.toFixed(2)}, Duration: ${(phase2b.durationMs / 1000).toFixed(0)}s`));
    } catch (error) {
      log(chalk.red('  ✗') + ` Verification failed: ${error instanceof Error ? error.message : error}`);
      log(chalk.dim('    Continuing without LLM adjustments...'));
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
  const scoring = computeScores(staticResult, taskResults, skipEmpirical);
  let { categories, overallScore, grade } = scoring;

  // Apply LLM verification adjustments (±15 points per category)
  if (llmAdjustments) {
    const adjustMap: Record<string, number> = {
      'Documentation': llmAdjustments.documentation,
      'Naming': llmAdjustments.naming,
      'Coupling': llmAdjustments.coupling,
    };
    for (const cat of categories) {
      const adj = adjustMap[cat.name];
      if (adj !== undefined && adj !== 0) {
        cat.score = Math.max(0, Math.min(100, cat.score + adj));
        cat.findings.push(`LLM verification adjustment: ${adj > 0 ? '+' : ''}${adj} pts`);
      }
    }
    // Recompute overall score after adjustments
    overallScore = Math.round(categories.reduce((sum, cat) => sum + cat.score * cat.weight, 0));
    grade = overallScore >= 85 ? 'A' : overallScore >= 70 ? 'B' : overallScore >= 55 ? 'C' : overallScore >= 40 ? 'D' : 'F';
  }

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
  const { SCORING_VERSION } = await import('../constants.js');
  await saveHistory(options.path, {
    timestamp: new Date().toISOString(),
    overallScore,
    grade,
    categoryScores,
    targetPath: options.path,
    costUsd: totalCostUsd,
    scoringVersion: SCORING_VERSION,
  });

  // Save cache manifest for incremental analysis
  if (!options.noCache) {
    const { saveManifest } = await import('../core/cache.js');
    await saveManifest(options.path, entries);
  }

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

async function runMonorepo(
  options: CliOptions,
  packages: import('../types.js').MonorepoPackage[],
  log: (...args: unknown[]) => void,
): Promise<void> {
  const startTime = Date.now();
  const results: import('../types.js').MonorepoPackageResult[] = [];

  for (let i = 0; i < packages.length; i++) {
    const pkg = packages[i];
    log(chalk.yellow(`  [${i + 1}/${packages.length}]`) + ` Analyzing ${chalk.bold(pkg.name)} (${pkg.relativePath})`);

    try {
      const { result: staticResult } = await runStaticAnalysis(pkg.path, false);
      const { categories, overallScore, grade } = computeScores(staticResult, [], true);
      const recommendations = buildExecutableRecommendations(categories, staticResult, null);

      const topIssue = recommendations.length > 0 ? recommendations[0].title : 'No issues';

      results.push({
        package: pkg,
        score: overallScore,
        grade,
        topIssue,
        categories,
      });

      const bar = scoreBar(overallScore);
      log(`  ${bar} ${overallScore.toString().padStart(3)}/100 (${grade})`);
    } catch (error) {
      log(chalk.red(`  ✗ Failed: ${error instanceof Error ? error.message : error}`));
      results.push({
        package: pkg,
        score: 0,
        grade: 'F',
        topIssue: `Analysis failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        categories: [],
      });
    }
    log('');
  }

  // Compute aggregate score (weighted by file count)
  const totalFiles = results.reduce((s, r) => s + r.package.fileCount, 0);
  const aggregateScore = totalFiles > 0
    ? Math.round(results.reduce((s, r) => s + r.score * r.package.fileCount, 0) / totalFiles)
    : 0;
  const aggregateGrade = aggregateScore >= 85 ? 'A'
    : aggregateScore >= 70 ? 'B'
    : aggregateScore >= 55 ? 'C'
    : aggregateScore >= 40 ? 'D'
    : 'F';

  const totalDurationMs = Date.now() - startTime;

  // Output based on format
  if (options.format === 'json') {
    const jsonOutput = {
      version: '0.10.0',
      timestamp: new Date().toISOString(),
      target: options.path,
      monorepo: true,
      aggregateScore,
      aggregateGrade,
      packages: results.map(r => ({
        name: r.package.name,
        path: r.package.relativePath,
        fileCount: r.package.fileCount,
        score: r.score,
        grade: r.grade,
        topIssue: r.topIssue,
        categories: r.categories.map(c => ({
          name: c.name,
          score: c.score,
          weight: c.weight,
        })),
      })),
      meta: { duration: totalDurationMs, mode: 'static-only' },
    };
    process.stdout.write(JSON.stringify(jsonOutput, null, 2) + '\n');
  } else if (options.format === 'summary') {
    process.stdout.write(`${aggregateScore}/100 ${aggregateGrade} ${options.path} (monorepo: ${packages.length} packages)\n`);
  } else {
    // Markdown table
    log(chalk.bold('  Monorepo Analysis'));
    log('');
    log('  | Package | Score | Grade | Top Issue |');
    log('  |---------|-------|-------|-----------|');
    for (const r of results.sort((a, b) => b.score - a.score)) {
      const issue = r.topIssue.length > 40 ? r.topIssue.slice(0, 40) + '...' : r.topIssue;
      log(`  | ${r.package.name} | ${r.score} | ${r.grade} | ${issue} |`);
    }
    log(`  | **Aggregate** | **${aggregateScore}** | **${aggregateGrade}** | |`);
    log('');
  }

  // Summary
  log(chalk.bold('  Results'));
  log(`  Aggregate: ${aggregateScore}/100 (${aggregateGrade})`);
  log(`  Packages: ${packages.length}`);
  log(`  Time: ${formatDuration(totalDurationMs)}`);
  log('');

  // Min-score threshold
  if (options.minScore !== undefined && aggregateScore < options.minScore) {
    log(chalk.red(`  ✗ Aggregate score ${aggregateScore} is below minimum threshold of ${options.minScore}`));
    process.exit(1);
  }
}
