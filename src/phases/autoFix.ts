import { execFile } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile, unlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import chalk from 'chalk';
import { createIsolation, type IsolationContext } from '../core/isolation.js';
import { isGitRepo } from '../core/git.js';
import { callClaude } from '../core/claude.js';
import { runStaticAnalysis } from './staticAnalysis.js';
import { computeScores } from './scoring.js';
import { buildExecutableRecommendations } from '../report/recommendations.js';
import { COST_ESTIMATES } from '../constants.js';
import type { ExecutableRecommendation, CliOptions, AutoImproveResult } from '../types.js';

export interface FixResult {
  recommendation: ExecutableRecommendation;
  success: boolean;
  scoreBefore: number;
  scoreAfter: number;
  filesModified: string[];
  costUsd: number;
  error?: string;
}

function exec(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${cmd} failed: ${stderr || error.message}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

function buildFixPrompt(rec: ExecutableRecommendation): string {
  const lines: string[] = [];
  lines.push('You are improving a codebase\'s LLM-friendliness.');
  lines.push('');
  lines.push(`## Task: ${rec.title}`);
  lines.push('');
  lines.push('### Current State');
  lines.push(rec.currentState);
  lines.push('');
  lines.push('### Desired End State');
  lines.push(rec.desiredEndState);
  lines.push('');

  if (rec.filesToModify.length > 0) {
    lines.push('### Files to Modify');
    for (const f of rec.filesToModify) {
      lines.push(`- \`${f.path}\` — ${f.action}`);
    }
    lines.push('');
  }

  lines.push('### Implementation Steps');
  for (let i = 0; i < rec.implementationSteps.length; i++) {
    lines.push(`${i + 1}. ${rec.implementationSteps[i]}`);
  }
  lines.push('');

  lines.push('### Acceptance Criteria');
  for (const c of rec.acceptanceCriteria) {
    lines.push(`- ${c}`);
  }
  lines.push('');

  if (rec.context) {
    lines.push('### Context');
    lines.push(rec.context);
    lines.push('');
  }

  if (rec.draftContent) {
    lines.push('### Draft Content');
    lines.push('Use the following as a starting point:');
    lines.push('```');
    lines.push(rec.draftContent);
    lines.push('```');
    lines.push('');
  }

  lines.push('Important: Only make the changes described above. Do not make any other changes to the codebase.');
  return lines.join('\n');
}

async function getDiffSummary(cwd: string): Promise<{ stat: string; files: string[] }> {
  await exec('git', ['add', '-A'], cwd);
  const stat = await exec('git', ['diff', '--cached', '--stat', 'HEAD'], cwd).catch(() => '');
  const names = await exec('git', ['diff', '--cached', '--name-only', 'HEAD'], cwd).catch(() => '');
  return {
    stat,
    files: names ? names.split('\n').filter(Boolean) : [],
  };
}

async function detectBuildCommand(cwd: string): Promise<string | null> {
  try {
    const pkg = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf-8'));
    const scripts = pkg.scripts ?? {};
    // Check common build/check scripts in order of preference
    for (const name of ['build', 'typecheck', 'check', 'tsc']) {
      if (scripts[name]) return `npm run ${name}`;
    }
  } catch {}
  return null;
}

async function runBuildValidation(cwd: string, log: (...args: unknown[]) => void): Promise<boolean> {
  const buildCmd = await detectBuildCommand(cwd);
  if (!buildCmd) return true; // no build command — skip validation

  // Worktrees don't have node_modules — install deps first if needed
  try {
    const pkg = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf-8'));
    if (pkg.dependencies || pkg.devDependencies) {
      log(chalk.dim('  │  Installing dependencies in worktree...'));
      await exec('npm', ['install', '--ignore-scripts'], cwd);
    }
  } catch {}

  log(chalk.dim(`  │  Validating build (${buildCmd})...`));
  try {
    await exec('sh', ['-c', buildCmd], cwd);
    return true;
  } catch {
    return false;
  }
}

async function applyChanges(worktreeDir: string, targetDir: string, files: string[]): Promise<void> {
  for (const file of files) {
    const src = join(worktreeDir, file);
    const dst = join(targetDir, file);
    await mkdir(dirname(dst), { recursive: true });
    await copyFile(src, dst);
  }
}

async function confirm(message: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(message, (answer) => {
      rl.close();
      resolve(answer.toLowerCase().startsWith('y'));
    });
  });
}

export async function runAutoFix(
  options: CliOptions,
  recommendations: ExecutableRecommendation[],
  currentScore: number,
  log: (...args: unknown[]) => void,
): Promise<FixResult[]> {
  if (!(await isGitRepo(options.path))) {
    log(chalk.red('  Auto-fix requires a git repository. Non-git repos are read-only.'));
    return [];
  }

  // Select recommendations to fix
  let toFix: ExecutableRecommendation[];
  if (options.fixId) {
    const found = recommendations.find(r => r.id === options.fixId);
    if (!found) {
      log(chalk.red(`  Recommendation "${options.fixId}" not found. Available: ${recommendations.map(r => r.id).join(', ')}`));
      return [];
    }
    toFix = [found];
  } else {
    toFix = recommendations.slice(0, options.fixCount);
  }

  if (toFix.length === 0) {
    log(chalk.dim('  No recommendations to fix.'));
    return [];
  }

  log(chalk.yellow(`  Applying ${toFix.length} recommendation${toFix.length > 1 ? 's' : ''}${options.dryRun ? ' (dry run)' : ''}...`));
  log('');

  const results: FixResult[] = [];

  for (const rec of toFix) {
    log(chalk.bold(`  ┌─ ${rec.title}`));
    log(chalk.dim(`  │  Priority ${rec.priority} | Est. impact: +${rec.estimatedScoreImpact} pts`));

    let isolation: IsolationContext | undefined;
    try {
      // Create isolated worktree
      log(chalk.dim('  │  Creating worktree...'));
      isolation = await createIsolation(options.path, `fix-${rec.id}`);

      // Score the worktree BEFORE Claude makes changes — the worktree may differ
      // from the working directory (e.g., uncommitted changes), so we need a
      // same-baseline comparison to measure Claude's actual impact.
      const { result: baselineStatic } = await runStaticAnalysis(isolation.workDir, false);
      const { overallScore: baselineScore } = computeScores(baselineStatic, [], true);

      // Run Claude Code in the worktree
      // Auto-fix tasks (file splits, refactoring) are more complex than empirical tasks
      // and need higher timeout/budget defaults than the CLI defaults of 300s/$1.00
      log(chalk.dim('  │  Running Claude Code...'));
      const prompt = buildFixPrompt(rec);
      // Batched tasks (multiple files) need more budget than single-file tasks
      const isBatch = rec.filesToModify.length > 2;
      const fixBudget = Math.max(options.maxBudgetPerTask, isBatch ? 10.00 : 5.00);
      // Batch tasks (multi-file splits) need more time than single-file fixes
      const fixTimeout = isBatch ? 900_000 : 600_000;
      const claudeResult = await callClaude({
        prompt,
        cwd: isolation.workDir,
        maxTurns: options.maxTurnsPerTask,
        maxBudgetUsd: fixBudget,
        timeout: fixTimeout,
        model: options.model,
      });

      // Check what changed
      const diff = await getDiffSummary(isolation.workDir);
      if (diff.files.length === 0) {
        log(chalk.yellow('  │  No files were modified.'));
        results.push({
          recommendation: rec,
          success: false,
          scoreBefore: baselineScore,
          scoreAfter: baselineScore,
          filesModified: [],
          costUsd: claudeResult.costUsd,
          error: 'No changes made',
        });
        log(chalk.dim('  └─'));
        log('');
        if (!options.fixContinue) break;
        continue;
      }

      // Validate build before re-scoring — reject changes that break compilation
      const buildOk = await runBuildValidation(isolation.workDir, log);
      if (!buildOk) {
        log(chalk.red('  │  Build failed — discarding changes'));
        results.push({
          recommendation: rec,
          success: false,
          scoreBefore: baselineScore,
          scoreAfter: baselineScore,
          filesModified: diff.files,
          costUsd: claudeResult.costUsd,
          error: 'Build validation failed',
        });
        log(chalk.dim('  └─'));
        log('');
        if (!options.fixContinue) break;
        continue;
      }

      // Re-score the worktree — compare against the WORKTREE baseline,
      // not the working directory score, to isolate Claude's impact
      log(chalk.dim(`  │  Re-scoring (${diff.files.length} files changed)...`));
      const { result: newStatic } = await runStaticAnalysis(isolation.workDir, false);
      const { overallScore: newScore } = computeScores(newStatic, [], true);

      const delta = newScore - baselineScore;
      const improved = delta > 0;

      if (improved) {
        log(chalk.green(`  │  Score: ${baselineScore} → ${newScore} (+${delta})`));
      } else if (delta === 0) {
        log(chalk.yellow(`  │  Score: ${baselineScore} → ${newScore} (no change)`));
      } else {
        log(chalk.red(`  │  Score: ${baselineScore} → ${newScore} (${delta})`));
      }

      // Show diff summary
      if (diff.stat) {
        log(chalk.dim('  │'));
        for (const line of diff.stat.split('\n')) {
          log(chalk.dim(`  │  ${line}`));
        }
      }

      // Merge or discard
      if (options.dryRun) {
        log(chalk.cyan('  │  Dry run — changes NOT applied'));
        results.push({
          recommendation: rec,
          success: improved,
          scoreBefore: baselineScore,
          scoreAfter: newScore,
          filesModified: diff.files,
          costUsd: claudeResult.costUsd,
        });
      } else if (!improved) {
        log(chalk.yellow('  │  Score did not improve — discarding changes'));
        results.push({
          recommendation: rec,
          success: false,
          scoreBefore: baselineScore,
          scoreAfter: newScore,
          filesModified: [],
          costUsd: claudeResult.costUsd,
          error: `Score did not improve (${delta >= 0 ? 'no change' : `decreased by ${Math.abs(delta)}`})`,
        });
        if (!options.fixContinue) break;
      } else {
        // Score improved — merge back (with confirmation unless --yes)
        let shouldMerge = true;
        if (!options.yes) {
          log('  │');
          shouldMerge = await confirm('  │  Apply these changes? (y/n) ');
        }

        if (shouldMerge) {
          await applyChanges(isolation.workDir, options.path, diff.files);
          log(chalk.green('  │  Changes applied'));
          results.push({
            recommendation: rec,
            success: true,
            scoreBefore: baselineScore,
            scoreAfter: newScore,
            filesModified: diff.files,
            costUsd: claudeResult.costUsd,
          });
          currentScore = newScore;
        } else {
          log(chalk.yellow('  │  Changes discarded by user'));
          results.push({
            recommendation: rec,
            success: false,
            scoreBefore: baselineScore,
            scoreAfter: newScore,
            filesModified: [],
            costUsd: claudeResult.costUsd,
            error: 'User declined changes',
          });
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log(chalk.red(`  │  Failed: ${msg}`));
      results.push({
        recommendation: rec,
        success: false,
        scoreBefore: currentScore,
        scoreAfter: currentScore,
        filesModified: [],
        costUsd: 0,
        error: msg,
      });
      if (!options.fixContinue) break;
    } finally {
      if (isolation) await isolation.cleanup();
      log(chalk.dim('  └─'));
      log('');
    }
  }

  return results;
}

export async function runAutoImprove(
  options: CliOptions,
  startScore: number,
  log: (...args: unknown[]) => void,
): Promise<AutoImproveResult> {
  const targetScore = options.target!;
  const maxIterations = options.maxIterations;
  const maxBudget = options.maxTotalBudget;

  let currentScore = startScore;
  let totalCostUsd = 0;
  let iteration = 0;
  const skippedRecIds = new Set<string>();
  const iterations: AutoImproveResult['iterations'] = [];

  while (currentScore < targetScore && iteration < maxIterations && totalCostUsd < maxBudget) {
    // Re-analyze to get fresh recommendations
    const { result: staticResult } = await runStaticAnalysis(options.path, false);
    const { categories, overallScore: workingDirScore } = computeScores(staticResult, [], true);
    currentScore = workingDirScore;
    const recommendations = buildExecutableRecommendations(categories, staticResult, null)
      .filter(r => r.estimatedScoreImpact > 0 && !skippedRecIds.has(r.id));

    if (recommendations.length === 0) {
      log(chalk.dim('  No more improvements available'));
      break;
    }

    // Pick top recommendation by ROI (impact first)
    const topRec = recommendations[0];
    iteration++;

    log(chalk.yellow(`  [${iteration}/${maxIterations}]`) + ` ${topRec.title}`);

    const fixResults = await runAutoFix(
      { ...options, fix: true, fixCount: 1, fixId: topRec.id, yes: true, fixContinue: true },
      recommendations,
      currentScore,
      (...args) => {}, // suppress inner logging
    );

    const result = fixResults[0];
    const iterCost = result ? result.costUsd : COST_ESTIMATES.agentCall;
    totalCostUsd += iterCost;

    if (!result || !result.success) {
      log(chalk.red(`    Failed — skipping`));
      skippedRecIds.add(topRec.id);
      iterations.push({
        index: iteration,
        recommendation: topRec.title,
        delta: 0,
        costUsd: iterCost,
        success: false,
      });
      continue;
    }

    const delta = result.scoreAfter - currentScore;
    currentScore = result.scoreAfter;

    log(chalk.green(`    ${result.scoreBefore} → ${result.scoreAfter} (+${delta}) | $${iterCost.toFixed(2)}`));

    iterations.push({
      index: iteration,
      recommendation: topRec.title,
      delta,
      costUsd: iterCost,
      success: true,
    });
  }

  return {
    startScore,
    finalScore: currentScore,
    targetScore,
    iterations,
    totalCostUsd,
    totalIterations: iteration,
    reachedTarget: currentScore >= targetScore,
  };
}

export function formatFixResults(results: FixResult[], log: (...args: unknown[]) => void): void {
  if (results.length === 0) return;

  const successes = results.filter(r => r.success).length;
  const totalCost = results.reduce((s, r) => s + r.costUsd, 0);

  log('');
  log(chalk.bold('  Auto-Fix Results'));
  log('  ' + '─'.repeat(48));

  for (const r of results) {
    const status = r.success ? chalk.green('Applied') : chalk.red('Skipped');
    const delta = r.scoreAfter - r.scoreBefore;
    const deltaStr = delta > 0 ? chalk.green(`+${delta}`) : delta === 0 ? '0' : chalk.red(`${delta}`);

    log(`  ${status}  ${r.recommendation.title}`);
    log(chalk.dim(`         Score: ${r.scoreBefore} → ${r.scoreAfter} (${deltaStr})  Cost: $${r.costUsd.toFixed(2)}`));
    if (r.filesModified.length > 0) {
      log(chalk.dim(`         Files: ${r.filesModified.join(', ')}`));
    }
    if (r.error) {
      log(chalk.dim(`         Reason: ${r.error}`));
    }
  }

  log('  ' + '─'.repeat(48));
  log(`  ${successes}/${results.length} applied | Total cost: $${totalCost.toFixed(2)}`);
  log('');
}
