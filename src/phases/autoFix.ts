import { execFile } from 'node:child_process';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

async function getDiffPatch(cwd: string): Promise<string> {
  await exec('git', ['add', '-A'], cwd);
  return exec('git', ['diff', '--cached', 'HEAD'], cwd).catch(() => '');
}

async function applyPatch(cwd: string, patch: string): Promise<void> {
  if (!patch.trim()) return;
  const patchFile = join(tmpdir(), `llm-sense-patch-${randomBytes(4).toString('hex')}.diff`);
  await writeFile(patchFile, patch, 'utf-8');
  try {
    await exec('git', ['apply', '--allow-empty', patchFile], cwd);
  } finally {
    try { await unlink(patchFile); } catch {}
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

      // Run Claude Code in the worktree
      log(chalk.dim('  │  Running Claude Code...'));
      const prompt = buildFixPrompt(rec);
      const claudeResult = await callClaude({
        prompt,
        cwd: isolation.workDir,
        maxTurns: options.maxTurnsPerTask,
        maxBudgetUsd: options.maxBudgetPerTask,
        model: options.model,
      });

      // Check what changed
      const diff = await getDiffSummary(isolation.workDir);
      if (diff.files.length === 0) {
        log(chalk.yellow('  │  No files were modified.'));
        results.push({
          recommendation: rec,
          success: false,
          scoreBefore: currentScore,
          scoreAfter: currentScore,
          filesModified: [],
          costUsd: claudeResult.costUsd,
          error: 'No changes made',
        });
        log(chalk.dim('  └─'));
        log('');
        if (!options.fixContinue) break;
        continue;
      }

      // Re-score the worktree
      log(chalk.dim(`  │  Re-scoring (${diff.files.length} files changed)...`));
      const { result: newStatic } = await runStaticAnalysis(isolation.workDir, false);
      const { overallScore: newScore } = computeScores(newStatic, [], true);

      const delta = newScore - currentScore;
      const improved = delta > 0;

      if (improved) {
        log(chalk.green(`  │  Score: ${currentScore} → ${newScore} (+${delta})`));
      } else if (delta === 0) {
        log(chalk.yellow(`  │  Score: ${currentScore} → ${newScore} (no change)`));
      } else {
        log(chalk.red(`  │  Score: ${currentScore} → ${newScore} (${delta})`));
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
          scoreBefore: currentScore,
          scoreAfter: newScore,
          filesModified: diff.files,
          costUsd: claudeResult.costUsd,
        });
      } else if (!improved) {
        log(chalk.yellow('  │  Score did not improve — discarding changes'));
        results.push({
          recommendation: rec,
          success: false,
          scoreBefore: currentScore,
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
          const patch = await getDiffPatch(isolation.workDir);
          await applyPatch(options.path, patch);
          log(chalk.green('  │  Changes applied'));
          results.push({
            recommendation: rec,
            success: true,
            scoreBefore: currentScore,
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
            scoreBefore: currentScore,
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
    const { categories } = computeScores(staticResult, [], true);
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
