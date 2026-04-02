import { callClaude } from '../core/claude.js';
import { createIsolation, type IsolationContext } from '../core/isolation.js';
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
): Promise<{ results: TaskExecutionResult[]; totalCostUsd: number; totalDurationMs: number }> {
  const results: TaskExecutionResult[] = [];
  let totalCostUsd = 0;
  let totalDurationMs = 0;

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const label = `[${i + 1}/${tasks.length}]`;
    console.log(chalk.cyan(`  ${label} ${task.type}: ${task.title}`));

    let isolation: IsolationContext | undefined;

    try {
      // Create isolated environment
      if (verbose) console.log(`    Creating ${task.type === 'bug' ? 'worktree' : 'isolated copy'}...`);
      isolation = await createIsolation(targetPath, task.id);
      if (verbose) console.log(`    Isolation ready: ${isolation.type} at ${isolation.workDir}`);

      // Build task prompt
      const prompt = buildTaskPrompt(task);

      // Run Claude with full tool access
      if (verbose) console.log(`    Running Claude (max ${maxTurns} turns, $${maxBudgetPerTask} budget)...`);

      const result = await callClaude({
        prompt,
        cwd: isolation.workDir,
        timeout: 600_000, // 10 min max per task
        model,
        maxTurns,
        maxBudgetUsd: maxBudgetPerTask,
        bare: false,
      });

      // Get files modified
      const filesModified = await gitDiffNames(isolation.workDir);

      const success = !result.isError && result.subtype !== 'error_max_turns';

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
        filesRead: [], // Can't easily track reads from JSON output
        filesModified,
        stopReason: result.stopReason,
        errors: result.isError ? [result.text.slice(0, 500)] : [],
      };

      results.push(execResult);
      totalCostUsd += result.costUsd;
      totalDurationMs += result.durationMs;

      const status = success ? chalk.green('PASS') : chalk.red('FAIL');
      console.log(`    ${status} — ${result.numTurns} turns, $${result.costUsd.toFixed(2)}, ${(result.durationMs / 1000).toFixed(0)}s, ${filesModified.length} files modified`);

    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.log(`    ${chalk.red('ERROR')} — ${errMsg.slice(0, 100)}`);

      results.push({
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
        stopReason: 'error',
        errors: [errMsg],
      });
    } finally {
      // Always clean up isolation
      if (isolation) {
        if (verbose) console.log('    Cleaning up isolation...');
        await isolation.cleanup();
      }
    }
  }

  return { results, totalCostUsd, totalDurationMs };
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
