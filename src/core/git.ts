import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';

function exec(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${cmd} ${args.join(' ')} failed: ${stderr || error.message}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

export async function isGitRepo(path: string): Promise<boolean> {
  try {
    await access(join(path, '.git'));
    return true;
  } catch {
    return false;
  }
}

export async function gitWorktreeAdd(repoPath: string, worktreePath: string): Promise<void> {
  await exec('git', ['worktree', 'add', '--detach', worktreePath, 'HEAD'], repoPath);
}

export async function gitWorktreeRemove(repoPath: string, worktreePath: string): Promise<void> {
  try {
    await exec('git', ['worktree', 'remove', '--force', worktreePath], repoPath);
  } catch {
    // Best-effort cleanup
  }
}

export async function gitDiffNames(cwd: string): Promise<string[]> {
  try {
    const output = await exec('git', ['diff', '--name-only', 'HEAD'], cwd);
    return output ? output.split('\n').filter(Boolean) : [];
  } catch {
    return [];
  }
}

export async function gitLsFiles(cwd: string): Promise<string[]> {
  try {
    const output = await exec('git', ['ls-files'], cwd);
    return output ? output.split('\n').filter(Boolean) : [];
  } catch {
    return [];
  }
}

// Returns files changed between current HEAD and the merge base with a branch.
// Falls back to HEAD~1 if no base branch can be determined.
export async function gitChangedFiles(cwd: string, baseBranch?: string): Promise<string[]> {
  try {
    // Try to find merge base with default branch
    const base = baseBranch ?? 'main';
    const mergeBase = await exec('git', ['merge-base', base, 'HEAD'], cwd).catch(() => null);
    const ref = mergeBase ?? 'HEAD~1';
    const output = await exec('git', ['diff', '--name-only', ref], cwd);
    return output ? output.split('\n').filter(Boolean) : [];
  } catch {
    return [];
  }
}
