import { cpus } from 'node:os';
import { normalize } from 'node:path';
import { callClaude } from '../core/claude.js';
import { createIsolation, type IsolationContext } from '../core/isolation.js';
import { isGitRepo } from '../core/git.js';
import { gitDiffNames } from '../core/git.js';
import type { SyntheticTask, TaskExecutionResult } from '../types.js';
import chalk from 'chalk';

export async function runEmpiricalTesting(
  targetPath: string,
  tasks: SyntheticTask[],
  maxTurns: number,
  maxBudgetPerTask: number,
  verbose: boolean,
  model?: string,
  concurrency?: number,
): Promise<{ results: TaskExecutionResult[]; totalCostUsd: number; totalDurationMs: number }> {
  // Determine concurrency: user override, or auto-detect
  const isGit = await isGitRepo(targetPath);
  const autoConc = Math.min(Math.floor(cpus().length / 2), 5);
  let conc = concurrency ?? autoConc;
  // Non-git repos use rsync copies — limit concurrency to avoid disk thrashing
  if (!isGit && conc > 2) conc = 2;
  conc = Math.max(1, conc);

  if (verbose) console.log(`  Concurrency: ${conc} (${isGit ? 'worktree' : 'tmpdir-copy'} isolation)`);

  const results: (TaskExecutionResult | undefined)[] = new Array(tasks.length);
  let totalCostUsd = 0;
  let totalDurationMs = 0;

  await runWithConcurrency(tasks, conc, async (task, index) => {
    const label = `[${index + 1}/${tasks.length}]`;
    console.log(chalk.cyan(`  ${label} ${task.type}: ${task.title}`));

    let isolation: IsolationContext | undefined;

    try {
      if (verbose) console.log(`    ${label} Creating isolation...`);
      isolation = await createIsolation(targetPath, task.id);
      if (verbose) console.log(`    ${label} Isolation ready: ${isolation.type} at ${isolation.workDir}`);

      const prompt = buildTaskPrompt(task);

      if (verbose) console.log(`    ${label} Running Claude (max ${maxTurns} turns, $${maxBudgetPerTask} budget)...`);

      const result = await callClaude({
        prompt,
        cwd: isolation.workDir,
        timeout: 600_000,
        model,
        maxTurns,
        maxBudgetUsd: maxBudgetPerTask,
        bare: false,
      });

      const filesModified = await gitDiffNames(isolation.workDir);

      // Compute correctness by comparing expected vs actual files modified
      const { fileOverlapScore, unexpectedFiles, correctnessScore } = computeCorrectness(
        task.expectedFilesTouch,
        filesModified,
      );

      const success = !result.isError
        && result.subtype !== 'error_max_turns'
        && filesModified.length > 0
        && (task.expectedFilesTouch.length === 0 || fileOverlapScore >= 0.5);

      const execResult: TaskExecutionResult = {
        taskId: task.id,
        taskType: task.type,
        taskTitle: task.title,
        success,
        durationMs: result.durationMs,
        durationApiMs: result.durationApiMs,
        numTurns: result.numTurns,
        totalCostUsd: result.costUsd,
        tokenUsage: {
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          cacheReadTokens: result.cacheReadTokens,
          cacheCreationTokens: result.cacheCreationTokens,
        },
        filesRead: [],
        filesModified,
        fileOverlapScore,
        unexpectedFilesModified: unexpectedFiles,
        correctnessScore,
        stopReason: result.stopReason,
        errors: result.isError ? [result.text.slice(0, 500)] : [],
      };

      results[index] = execResult;
      totalCostUsd += result.costUsd;
      totalDurationMs += result.durationMs;

      const status = success ? chalk.green('PASS') : chalk.red('FAIL');
      const corrPct = `${Math.round(fileOverlapScore * 100)}%`;
      console.log(`    ${label} ${status} — ${result.numTurns} turns, $${result.costUsd.toFixed(2)}, ${(result.durationMs / 1000).toFixed(0)}s, ${filesModified.length} files, correctness ${corrPct}`);

    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.log(`    ${label} ${chalk.red('ERROR')} — ${errMsg.slice(0, 100)}`);

      results[index] = {
        taskId: task.id,
        taskType: task.type,
        taskTitle: task.title,
        success: false,
        durationMs: 0,
        durationApiMs: 0,
        numTurns: 0,
        totalCostUsd: 0,
        tokenUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
        filesRead: [],
        filesModified: [],
        fileOverlapScore: 0,
        unexpectedFilesModified: [],
        correctnessScore: 0,
        stopReason: 'error',
        errors: [errMsg],
      };
    } finally {
      if (isolation) {
        if (verbose) console.log(`    ${label} Cleaning up isolation...`);
        await isolation.cleanup();
      }
    }
  });

  // Filter out any undefined entries (shouldn't happen, but be safe)
  const finalResults = results.filter((r): r is TaskExecutionResult => r !== undefined);

  return { results: finalResults, totalCostUsd, totalDurationMs };
}

// Bounded concurrency executor — runs up to `concurrency` items at once.
async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const running = new Set<Promise<void>>();

  function startNext(): Promise<void> | undefined {
    if (nextIndex >= items.length) return undefined;
    const index = nextIndex++;
    const promise = fn(items[index], index).finally(() => {
      running.delete(promise);
    });
    running.add(promise);
    return promise;
  }

  // Fill initial slots
  while (running.size < concurrency && nextIndex < items.length) {
    startNext();
  }

  // As each completes, start the next
  while (running.size > 0) {
    await Promise.race(running);
    while (running.size < concurrency && nextIndex < items.length) {
      startNext();
    }
  }
}

function normalizePath(p: string): string {
  return normalize(p).replace(/^\.\//, '');
}

function computeCorrectness(
  expected: string[],
  actual: string[],
): { fileOverlapScore: number; unexpectedFiles: string[]; correctnessScore: number } {
  if (expected.length === 0) {
    return { fileOverlapScore: 1.0, unexpectedFiles: [], correctnessScore: 1.0 };
  }

  const normalizedExpected = new Set(expected.map(normalizePath));
  const normalizedActual = new Set(actual.map(normalizePath));

  let matched = 0;
  for (const exp of normalizedExpected) {
    if (normalizedActual.has(exp)) matched++;
  }

  const unexpectedFiles = actual.filter(f => !normalizedExpected.has(normalizePath(f)));

  const fileOverlapScore = matched / normalizedExpected.size;
  const precision = normalizedActual.size > 0 ? matched / normalizedActual.size : 0;
  const correctnessScore = 0.7 * fileOverlapScore + 0.3 * precision;

  return { fileOverlapScore, unexpectedFiles, correctnessScore };
}

function buildTaskPrompt(task: SyntheticTask): string {
  return `You are a senior developer working on this codebase.

TASK: ${task.title}
TYPE: ${task.type}
DIFFICULTY: ${task.difficulty}

DESCRIPTION:
${task.description}

ACCEPTANCE CRITERIA:
${task.acceptanceCriteria.map(c => `- ${c}`).join('\n')}

EXPECTED FILES TO MODIFY:
${task.expectedFilesTouch.map(f => `- ${f}`).join('\n')}

INSTRUCTIONS:
1. Read and understand the relevant parts of the codebase
2. Implement the solution by modifying the necessary files
3. Do NOT install dependencies, run builds, or run tests
4. Do NOT create new configuration files
5. Focus on making clean, minimal changes
6. When done, briefly summarize what you changed and why`;
}
