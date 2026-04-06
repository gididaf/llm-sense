import { execFile } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile, unlink, rm, stat } from 'node:fs/promises';
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
import { ClaudeCliError } from '../types.js';

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

  // Add build verification step — the changes MUST compile
  lines.push('');
  lines.push('### CRITICAL: Build Verification');
  lines.push('After making all changes, you MUST verify the code compiles:');
  lines.push('1. Look at package.json (root and subdirectories) to find the build/typecheck command');
  lines.push('2. Run the build command to verify no TypeScript or compilation errors');
  lines.push('3. If the build fails, FIX the errors before finishing — broken code will be rejected');

  // Add efficiency hints for split tasks to reduce Claude's exploration time
  if (rec.title.toLowerCase().includes('split') || rec.title.toLowerCase().includes('bundled')) {
    lines.push('');
    lines.push('### Efficiency Guidelines');
    lines.push('- Read the target file ONCE, then plan the split before writing any files.');
    lines.push('- Group related functions/sections together when splitting — prefer 3-5 output files, not 10+.');
    lines.push('- CRITICAL ORDERING: For each chunk you extract, write the new file AND immediately remove that code from the original file before moving to the next chunk. Do NOT create all new files first then update the original — you may run out of turns.');
    lines.push('- The original file should end up as a slim barrel that re-exports from the new modules.');
    lines.push('- Only update imports in files that directly import from the split file. Do not scan the entire codebase.');
    lines.push('- Prefer moving code blocks as-is rather than refactoring during the split.');
    lines.push('- Keep the number of new files small (3-5). Fewer larger files are better than many tiny ones.');
  }

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

async function detectPackageManager(cwd: string): Promise<'pnpm' | 'yarn' | 'npm'> {
  for (const [file, pm] of [
    ['pnpm-lock.yaml', 'pnpm'], ['pnpm-workspace.yaml', 'pnpm'], ['yarn.lock', 'yarn'],
  ] as const) {
    try { await stat(join(cwd, file)); return pm; } catch {}
  }
  return 'npm';
}

function findBuildScript(scripts: Record<string, string>): string | null {
  for (const name of ['build', 'typecheck', 'check', 'tsc']) {
    if (scripts[name]) return name;
  }
  return null;
}

// Find build commands in root and workspace packages. For monorepos with no root
// build script, scans subdirectories for package.json files with build commands.
async function detectBuildCommands(cwd: string, changedFiles: string[]): Promise<{ pm: string; commands: string[] }> {
  const pm = await detectPackageManager(cwd);
  const commands: string[] = [];

  // Check root package.json
  try {
    const pkg = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf-8'));
    const script = findBuildScript(pkg.scripts ?? {});
    if (script) {
      commands.push(`${pm} run ${script}`);
      return { pm, commands };
    }
  } catch {}

  // Root has no build script — scan workspace packages that have changed files
  const changedDirs = new Set(changedFiles.map(f => f.split('/')[0]));
  for (const dir of changedDirs) {
    try {
      const pkgPath = join(cwd, dir, 'package.json');
      const pkg = JSON.parse(await readFile(pkgPath, 'utf-8'));
      const script = findBuildScript(pkg.scripts ?? {});
      if (script) {
        commands.push(`cd ${dir} && ${pm} run ${script}`);
      }
    } catch {}
  }

  return { pm, commands };
}

async function runBuildValidation(cwd: string, changedFiles: string[], log: (...args: unknown[]) => void): Promise<boolean> {
  const { pm, commands } = await detectBuildCommands(cwd, changedFiles);
  if (commands.length === 0) return true; // no build command — skip validation

  // Worktrees don't have node_modules — install deps first
  log(chalk.dim(`  │  Installing dependencies (${pm})...`));
  try {
    if (pm === 'pnpm') {
      await exec('pnpm', ['install', '--frozen-lockfile'], cwd);
    } else if (pm === 'yarn') {
      await exec('yarn', ['install', '--frozen-lockfile'], cwd);
    } else {
      await exec('npm', ['install', '--ignore-scripts'], cwd);
    }
  } catch {
    // If frozen lockfile fails, try without it
    try {
      await exec(pm, ['install'], cwd);
    } catch {}
  }

  for (const buildCmd of commands) {
    log(chalk.dim(`  │  Validating build (${buildCmd})...`));
    try {
      await exec('sh', ['-c', buildCmd], cwd);
    } catch {
      return false;
    }
  }
  return true;
}

async function applyChanges(worktreeDir: string, targetDir: string, files: string[]): Promise<void> {
  for (const file of files) {
    const src = join(worktreeDir, file);
    const dst = join(targetDir, file);
    await mkdir(dirname(dst), { recursive: true });
    await copyFile(src, dst);
  }
}

// Sync uncommitted/untracked changes from the working directory into a worktree.
// This ensures that when running multiple auto-fix passes, each worktree includes
// changes applied by previous passes (which haven't been committed yet).
async function syncWorkingDirToWorktree(targetPath: string, worktreePath: string): Promise<void> {
  // Get modified + untracked files in working directory
  const modified = await exec('git', ['diff', '--name-only', 'HEAD'], targetPath).catch(() => '');
  const staged = await exec('git', ['diff', '--cached', '--name-only', 'HEAD'], targetPath).catch(() => '');
  const untracked = await exec('git', ['ls-files', '--others', '--exclude-standard'], targetPath).catch(() => '');

  const allFiles = new Set<string>();
  for (const line of [modified, staged, untracked].join('\n').split('\n')) {
    const f = line.trim();
    if (f) allFiles.add(f);
  }

  if (allFiles.size === 0) return;

  for (const file of allFiles) {
    const src = join(targetPath, file);
    const dst = join(worktreePath, file);
    try {
      await stat(src);
      await mkdir(dirname(dst), { recursive: true });
      await copyFile(src, dst);
    } catch {
      // File may have been deleted in working dir — skip
    }
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

// Bundle a primary recommendation with same-category siblings into one task.
// This ensures all problems in a category are addressed together (e.g., splitting
// code files AND extracting data files in the same File Sizes pass).
function bundleSameCategory(
  primary: ExecutableRecommendation,
  siblings: ExecutableRecommendation[],
): ExecutableRecommendation {
  if (siblings.length === 0) return primary;

  const allFiles = [...primary.filesToModify];
  const allSteps = [...primary.implementationSteps];
  const allCriteria = [...primary.acceptanceCriteria];
  const titles = [primary.title];

  for (const sib of siblings) {
    titles.push(sib.title);
    for (const f of sib.filesToModify) {
      if (!allFiles.some(ef => ef.path === f.path)) {
        allFiles.push(f);
      }
    }
    allSteps.push(...sib.implementationSteps);
    allCriteria.push(...sib.acceptanceCriteria);
  }

  return {
    ...primary,
    title: `${primary.category}: ${titles.length} bundled tasks`,
    filesToModify: allFiles,
    implementationSteps: allSteps,
    acceptanceCriteria: allCriteria,
    estimatedScoreImpact: primary.estimatedScoreImpact + siblings.reduce((s, r) => s + r.estimatedScoreImpact, 0),
    context: [primary.context, ...siblings.map(s => s.context)].filter(Boolean).join('\n\n'),
    draftContent: [primary.draftContent, ...siblings.map(s => s.draftContent)].filter(Boolean).join('\n\n') || undefined,
  };
}

// Group selected recommendations by category and bundle each group.
// Also pulls in unselected same-category recs from the full list for maximum impact.
function bundleByCategory(
  selected: ExecutableRecommendation[],
  allRecs: ExecutableRecommendation[],
): ExecutableRecommendation[] {
  const seen = new Set<string>();
  const result: ExecutableRecommendation[] = [];

  for (const rec of selected) {
    if (seen.has(rec.category)) continue;
    seen.add(rec.category);

    // Find all same-category recs (from full list, not just selected)
    const siblings = allRecs.filter(r => r.category === rec.category && r.id !== rec.id);
    result.push(bundleSameCategory(rec, siblings));
  }

  return result;
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
    // Bundle all same-category recommendations into one session for maximum impact.
    // E.g., if fixing a file-split rec, also include data file extraction recs in the same category.
    const sameCategory = recommendations.filter(r => r.category === found.category && r.id !== found.id);
    toFix = [bundleSameCategory(found, sameCategory)];
  } else {
    // Group selected recommendations by category and bundle each group
    const selected = recommendations.slice(0, options.fixCount);
    toFix = bundleByCategory(selected, recommendations);
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

      // Sync uncommitted changes from previous auto-fix passes into the worktree.
      // Without this, each worktree starts from git HEAD and doesn't include
      // improvements applied by earlier recommendations in the same session.
      await syncWorkingDirToWorktree(options.path, isolation.workDir);

      // Score the worktree BEFORE Claude makes changes — the worktree may differ
      // from the working directory (e.g., uncommitted changes), so we need a
      // same-baseline comparison to measure Claude's actual impact.
      const { result: baselineStatic } = await runStaticAnalysis(isolation.workDir, false);
      const { categories: baselineCategories, overallScore: baselineScore } = computeScores(baselineStatic, [], true);

      // Run Claude Code in the worktree
      // Auto-fix tasks (file splits, refactoring) are more complex than empirical tasks
      // and need higher timeout/budget defaults than the CLI defaults of 300s/$1.00
      log(chalk.dim('  │  Running Claude Code...'));
      const prompt = buildFixPrompt(rec);
      // Batched tasks (multiple files) need more budget than single-file tasks
      const isBatch = rec.filesToModify.length > 2;
      const isSplit = rec.title.toLowerCase().includes('split');
      const fixBudget = Math.max(options.maxBudgetPerTask, isBatch ? 10.00 : 5.00);
      // File splits need more time — large files (2000+ lines) routinely need 15-25 min
      // with Claude Code due to reading, planning, creating files, and updating imports
      const fixTimeout = isBatch ? 1800_000 : isSplit ? 1800_000 : 600_000;
      // Split tasks need more turns — reading 3000+ line files, planning,
      // writing multiple new files, and updating imports takes many tool calls
      const fixMaxTurns = isSplit ? Math.max(options.maxTurnsPerTask, 50) : options.maxTurnsPerTask;
      const claudeResult = await callClaude({
        prompt,
        cwd: isolation.workDir,
        maxTurns: fixMaxTurns,
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
      const buildOk = await runBuildValidation(isolation.workDir, diff.files, log);
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
      // not the working directory score, to isolate Claude's impact.
      // Check both overall score AND targeted category score — a fix that
      // genuinely improves its category should be kept even if the overall
      // score doesn't budge (e.g., due to other unrelated problems).
      log(chalk.dim(`  │  Re-scoring (${diff.files.length} files changed)...`));
      const { result: newStatic } = await runStaticAnalysis(isolation.workDir, false);
      const { categories: newCategories, overallScore: newScore } = computeScores(newStatic, [], true);

      const delta = newScore - baselineScore;
      const overallImproved = delta > 0;

      // Check if the targeted category improved (even if overall didn't move)
      const targetCategory = rec.category;
      const baselineCatScore = baselineCategories.find(c => c.name === targetCategory)?.score ?? 0;
      const newCatScore = newCategories.find(c => c.name === targetCategory)?.score ?? 0;
      const catDelta = newCatScore - baselineCatScore;
      const categoryImproved = catDelta > 0;

      // Accept if: overall improved OR (category improved AND overall didn't decrease)
      const improved = overallImproved || (categoryImproved && delta >= 0);

      if (overallImproved) {
        log(chalk.green(`  │  Score: ${baselineScore} → ${newScore} (+${delta})`));
      } else if (categoryImproved) {
        log(chalk.green(`  │  Score: ${baselineScore} → ${newScore} (${targetCategory}: ${baselineCatScore} → ${newCatScore}, +${catDelta})`));
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
      if (error instanceof ClaudeCliError && error.stderr) {
        // Show stderr snippet to help diagnose Claude CLI failures
        const stderrSnippet = error.stderr.trim().split('\n').slice(-3).join('\n');
        if (stderrSnippet) log(chalk.dim(`  │  ${stderrSnippet}`));
      }
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
