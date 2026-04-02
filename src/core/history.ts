import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { HistoryEntry } from '../types.js';
import chalk from 'chalk';

// History is stored inside the target codebase as .llm-sense/history.json.
// This way each project keeps its own score timeline, and it can be committed to git
// for team visibility. The directory is created on first run if it doesn't exist.
const HISTORY_DIR = '.llm-sense';
const HISTORY_FILE = 'history.json';

function getHistoryPath(targetPath: string): string {
  return join(targetPath, HISTORY_DIR, HISTORY_FILE);
}

export async function loadHistory(targetPath: string): Promise<HistoryEntry[]> {
  try {
    const content = await readFile(getHistoryPath(targetPath), 'utf-8');
    return JSON.parse(content);
  } catch {
    return [];
  }
}

export async function saveHistory(targetPath: string, entry: HistoryEntry): Promise<void> {
  const dir = join(targetPath, HISTORY_DIR);
  try { await mkdir(dir, { recursive: true }); } catch {}

  const history = await loadHistory(targetPath);
  history.push(entry);
  await writeFile(getHistoryPath(targetPath), JSON.stringify(history, null, 2) + '\n', 'utf-8');
}

export async function getPreviousScore(targetPath: string): Promise<number | null> {
  const history = await loadHistory(targetPath);
  if (history.length === 0) return null;
  return history[history.length - 1].overallScore;
}

export function formatHistoryTable(history: HistoryEntry[]): string {
  if (history.length === 0) return '  No history found. Run llm-sense first.';

  const lines: string[] = [];
  lines.push('');
  lines.push('  ' + chalk.bold('Score History'));
  lines.push('');
  lines.push('  Date                 Score  Grade  Cost');
  lines.push('  ' + '─'.repeat(50));

  for (let i = 0; i < history.length; i++) {
    const entry = history[i];
    const date = new Date(entry.timestamp).toLocaleString();
    const delta = i > 0 ? entry.overallScore - history[i - 1].overallScore : 0;
    const deltaStr = i > 0
      ? (delta >= 0 ? chalk.green(` (+${delta})`) : chalk.red(` (${delta})`))
      : '';
    const cost = entry.costUsd > 0 ? `$${entry.costUsd.toFixed(2)}` : 'free';

    lines.push(`  ${date.padEnd(22)} ${String(entry.overallScore).padEnd(6)} ${entry.grade.padEnd(6)} ${cost}${deltaStr}`);
  }

  lines.push('');
  return lines.join('\n');
}
