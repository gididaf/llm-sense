import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { isGitRepo, gitWorktreeAdd, gitWorktreeRemove } from './git.js';
import { IsolationError } from '../types.js';

export interface IsolationContext {
  workDir: string;
  type: 'worktree' | 'tmpdir-copy';
  cleanup: () => Promise<void>;
}

const activeIsolations: IsolationContext[] = [];

function exec(cmd: string, args: string[], cwd?: string): Promise<string> {
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

export async function createIsolation(
  targetPath: string,
  taskId: string,
): Promise<IsolationContext> {
  const id = `${taskId}-${randomBytes(4).toString('hex')}`;

  if (await isGitRepo(targetPath)) {
    return createWorktreeIsolation(targetPath, id);
  } else {
    return createTmpdirIsolation(targetPath, id);
  }
}

async function createWorktreeIsolation(
  targetPath: string,
  id: string,
): Promise<IsolationContext> {
  const worktreePath = join(tmpdir(), `llm-sense-wt-${id}`);

  try {
    await gitWorktreeAdd(targetPath, worktreePath);
  } catch (e) {
    throw new IsolationError(`Failed to create worktree: ${e}`);
  }

  const ctx: IsolationContext = {
    workDir: worktreePath,
    type: 'worktree',
    cleanup: async () => {
      await gitWorktreeRemove(targetPath, worktreePath);
      try { await rm(worktreePath, { recursive: true, force: true }); } catch {}
      const idx = activeIsolations.indexOf(ctx);
      if (idx !== -1) activeIsolations.splice(idx, 1);
    },
  };
  activeIsolations.push(ctx);
  return ctx;
}

async function createTmpdirIsolation(
  targetPath: string,
  id: string,
): Promise<IsolationContext> {
  const copyPath = join(tmpdir(), `llm-sense-cp-${id}`);

  try {
    await exec('rsync', [
      '-a',
      '--exclude=node_modules',
      '--exclude=.git',
      '--exclude=dist',
      '--exclude=build',
      '--exclude=__pycache__',
      '--exclude=.next',
      '--exclude=.nuxt',
      '--exclude=target',
      '--exclude=coverage',
      '--exclude=.venv',
      '--exclude=venv',
      `${targetPath}/`,
      `${copyPath}/`,
    ]);

    // Initialize a git repo so we can diff after
    await exec('git', ['init'], copyPath);
    await exec('git', ['-c', 'user.name=llm-sense', '-c', 'user.email=noreply@llm-sense', 'add', '-A'], copyPath);
    await exec('git', ['-c', 'user.name=llm-sense', '-c', 'user.email=noreply@llm-sense', 'commit', '-m', 'baseline', '--allow-empty'], copyPath);
  } catch (e) {
    throw new IsolationError(`Failed to create tmpdir copy: ${e}`);
  }

  const ctx: IsolationContext = {
    workDir: copyPath,
    type: 'tmpdir-copy',
    cleanup: async () => {
      try { await rm(copyPath, { recursive: true, force: true }); } catch {}
      const idx = activeIsolations.indexOf(ctx);
      if (idx !== -1) activeIsolations.splice(idx, 1);
    },
  };
  activeIsolations.push(ctx);
  return ctx;
}

export async function cleanupAll(): Promise<void> {
  const copies = [...activeIsolations];
  for (const iso of copies) {
    await iso.cleanup();
  }
}

// Register cleanup on process exit
process.on('SIGINT', async () => {
  await cleanupAll();
  process.exit(130);
});
process.on('SIGTERM', async () => {
  await cleanupAll();
  process.exit(143);
});
