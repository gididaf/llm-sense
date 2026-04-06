import chalk from 'chalk';
import { runStaticAnalysis } from './staticAnalysis.js';
import { runLlmUnderstanding, runLlmVerification } from './llmUnderstanding.js';
import { runTaskGeneration } from './taskGeneration.js';
import { runEmpiricalTesting } from './empiricalTesting.js';
import { cleanupAll } from '../core/isolation.js';
import type {
  CliOptions, CodebaseUnderstanding, TaskGenerationResponse,
  TaskExecutionResult, StaticAnalysisResult, WalkEntry,
} from '../types.js';
import type { LlmLintResult } from './llmLint.js';
import type { LogFn } from './runnerUtils.js';

export interface PhaseResults {
  staticResult: StaticAnalysisResult;
  entries: WalkEntry[];
  understanding: CodebaseUnderstanding | null;
  tasks: TaskGenerationResponse | null;
  taskResults: TaskExecutionResult[];
  llmAdjustments: import('../types.js').LlmVerificationAdjustments | null;
  llmLintResult: LlmLintResult | null;
  totalCostUsd: number;
  phase2Cached: boolean;
}

export async function runPhase1(
  options: CliOptions,
  log: LogFn,
): Promise<{ staticResult: StaticAnalysisResult; entries: WalkEntry[] }> {
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

  const { result: staticResult, entries } = await runStaticAnalysis(options.path, options.verbose, options.noAst);
  log(chalk.green('  ✓') + ` ${staticResult.fileSizes.totalFiles} source files, ${staticResult.fileSizes.totalLines.toLocaleString()} lines analyzed`);

  // Git history enrichment (--git-history flag)
  if (options.gitHistory) {
    log(chalk.yellow('Phase 1b:') + ' Git History Analysis');
    try {
      const { analyzeGitHistory } = await import('../analyzers/gitHistory.js');
      const gitResult = await analyzeGitHistory(options.path, options.verbose, staticResult.astAnalysis);
      if (gitResult) {
        staticResult.gitHistory = gitResult;
        log(chalk.green('  ✓') + ` ${gitResult.totalCommitsAnalyzed} commits analyzed, ${gitResult.fileImportance.length} important files, ${gitResult.hotspots.length} hotspots`);
        if (gitResult.knowledgeConcentration.length > 0) {
          log(chalk.dim(`    ${gitResult.knowledgeConcentration.length} files with bus-factor risk`));
        }
        if (gitResult.conventionTrend.direction !== 'stable') {
          log(chalk.dim(`    Convention trend: ${gitResult.conventionTrend.direction}`));
        }
      } else {
        log(chalk.dim('  Skipped — not a git repo or no history'));
      }
    } catch (error) {
      log(chalk.red('  ✗') + ` Git history analysis failed: ${error instanceof Error ? error.message : error}`);
    }
    log('');
  }
  log('');

  return { staticResult, entries };
}

export async function runPhases2to4(
  options: CliOptions,
  entries: WalkEntry[],
  staticResult: StaticAnalysisResult,
  log: LogFn,
): Promise<{
  understanding: CodebaseUnderstanding | null;
  tasks: TaskGenerationResponse | null;
  taskResults: TaskExecutionResult[];
  llmAdjustments: import('../types.js').LlmVerificationAdjustments | null;
  llmLintResult: LlmLintResult | null;
  totalCostUsd: number;
  phase2Cached: boolean;
}> {
  let understanding: CodebaseUnderstanding | null = null;
  let tasks: TaskGenerationResponse | null = null;
  let taskResults: TaskExecutionResult[] = [];
  let llmAdjustments: import('../types.js').LlmVerificationAdjustments | null = null;
  let llmLintResult: LlmLintResult | null = null;
  let totalCostUsd = 0;
  let phase2Cached = false;

  // Check Phase 2 cache for scoring consistency
  const { loadPhase2Cache, savePhase2Cache } = await import('../core/cache.js');
  const phase2Cache = !options.noCache ? await loadPhase2Cache(options.path, entries) : null;

  if (phase2Cache) {
    log(chalk.yellow('Phase 2:') + ' LLM Codebase Understanding ' + chalk.dim('(cached)'));
    understanding = phase2Cache.understanding as CodebaseUnderstanding;
    phase2Cached = true;
    if (understanding) {
      log(chalk.green('  ✓') + ` ${understanding.projectName} — ${understanding.complexity} complexity (from cache — $0.00)`);
    }
    log('');

    log(chalk.yellow('Phase 2b:') + ' LLM Verification ' + chalk.dim('(cached)'));
    if (phase2Cache.verification) {
      const { LlmVerificationSchema } = await import('../types.js');
      try {
        const v = LlmVerificationSchema.parse(phase2Cache.verification);
        const { computeLlmAdjustments } = await import('./llmUnderstanding.js');
        llmAdjustments = computeLlmAdjustments(v);
        log(chalk.green('  ✓') + ` Doc: ${v.documentationQuality.score}/10, Naming: ${v.namingClarity.score}/10, Architecture: ${v.architectureClarity.score}/10 (from cache)`);
      } catch {
        log(chalk.dim('  Cached verification data invalid — skipping'));
      }
    }
    log('');
  } else {
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
    let verificationData: unknown = null;
    log(chalk.yellow('Phase 2b:') + ' LLM Verification');
    try {
      const phase2b = await runLlmVerification(
        options.path, entries, staticResult, options.verbose, options.model,
      );
      llmAdjustments = phase2b.adjustments;
      verificationData = phase2b.verification;
      totalCostUsd += phase2b.costUsd;
      const v = phase2b.verification;
      log(chalk.green('  ✓') + ` Doc: ${v.documentationQuality.score}/10, Naming: ${v.namingClarity.score}/10, Architecture: ${v.architectureClarity.score}/10`);
      log(chalk.dim(`    Cost: $${phase2b.costUsd.toFixed(2)}, Duration: ${(phase2b.durationMs / 1000).toFixed(0)}s`));
    } catch (error) {
      log(chalk.red('  ✗') + ` Verification failed: ${error instanceof Error ? error.message : error}`);
      log(chalk.dim('    Continuing without LLM adjustments...'));
    }
    log('');

    // Save Phase 2 results to cache for scoring consistency
    if (!options.noCache && (understanding || verificationData)) {
      try {
        await savePhase2Cache(options.path, entries, understanding, verificationData);
        if (options.verbose) log(chalk.dim('  Phase 2 results cached for consistency'));
      } catch { /* non-critical */ }
    }
  }

  // Phase 2c: LLM Lint Rules (only if not skipped with --no-llm-lint)
  if (!options.noLlmLint) {
    log(chalk.yellow('Phase 2c:') + ' LLM Lint Rules');
    try {
      const { runLlmLint } = await import('./llmLint.js');
      llmLintResult = await runLlmLint(
        options.path, entries, staticResult.astAnalysis, options.verbose, options.model,
      );
      totalCostUsd += llmLintResult.totalCostUsd;
      if (llmLintResult.findings.length > 0) {
        const errors = llmLintResult.findings.filter(f => f.severity === 'error').length;
        const warnings = llmLintResult.findings.filter(f => f.severity === 'warning').length;
        const infos = llmLintResult.findings.filter(f => f.severity === 'info').length;
        log(chalk.green('  ✓') + ` ${llmLintResult.findings.length} findings (${errors} errors, ${warnings} warnings, ${infos} info)`);
      } else {
        log(chalk.green('  ✓') + ` ${llmLintResult.candidatesEvaluated} candidates evaluated, no issues found`);
      }
      log(chalk.dim(`    Cost: $${llmLintResult.totalCostUsd.toFixed(2)}, Duration: ${(llmLintResult.durationMs / 1000).toFixed(0)}s, Rules: ${llmLintResult.rulesEvaluated}`));
    } catch (error) {
      log(chalk.red('  ✗') + ` LLM lint failed: ${error instanceof Error ? error.message : error}`);
      log(chalk.dim('    Continuing without LLM lint findings...'));
    }
    log('');
  }

  // Phase 3: Task Generation (only if Phase 2 succeeded)
  if (understanding) {
    log(chalk.yellow('Phase 3:') + ' Synthetic Task Generation');
    try {
      const phase3 = await runTaskGeneration(
        options.path, entries, understanding, staticResult,
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

  return { understanding, tasks, taskResults, llmAdjustments, llmLintResult, totalCostUsd, phase2Cached };
}
