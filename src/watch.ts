import { watch } from 'node:fs';
import { resolve } from 'node:path';
import chalk from 'chalk';
import { runStaticAnalysis } from './phases/staticAnalysis.js';
import { computeScores } from './phases/scoring.js';
import { IGNORED_DIRS } from './constants.js';

// Watch mode: re-runs Phase 1 + Phase 5 on file changes.
// Shows compact one-line score updates. Useful for live feedback
// while editing CLAUDE.md or refactoring file structure.
export async function runWatch(targetPath: string): Promise<void> {
  const absPath = resolve(targetPath);

  console.log('');
  console.log(chalk.bold('  llm-sense') + ' — Watch mode');
  console.log(chalk.dim(`  Target: ${absPath}`));
  console.log(chalk.dim('  Watching for changes... (Ctrl+C to stop)'));
  console.log('');

  // Run initial analysis
  await analyzeAndPrint(absPath);

  // Debounce timer
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  // Watch recursively
  try {
    const watcher = watch(absPath, { recursive: true }, (eventType, filename) => {
      if (!filename) return;

      // Skip ignored dirs and dotfiles
      const parts = filename.split('/');
      if (parts.some(p => IGNORED_DIRS.has(p) || p.startsWith('.'))) return;

      // Skip non-source files that won't affect scoring
      if (filename.endsWith('.map') || filename.endsWith('.min.js')) return;

      // Debounce: wait 500ms after last change before re-analyzing
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(async () => {
        await analyzeAndPrint(absPath);
      }, 500);
    });

    // Keep process alive
    await new Promise<void>((resolve) => {
      process.on('SIGINT', () => {
        watcher.close();
        console.log('');
        console.log(chalk.dim('  Watch mode stopped.'));
        resolve();
      });
    });
  } catch (error) {
    console.error(chalk.red(`  Watch error: ${error instanceof Error ? error.message : error}`));
    console.error(chalk.dim('  Note: recursive watch may not be supported on all platforms.'));
  }
}

async function analyzeAndPrint(targetPath: string): Promise<void> {
  try {
    const { result: staticResult } = await runStaticAnalysis(targetPath, false);
    const { categories, overallScore, grade } = computeScores(staticResult, [], true);

    const time = new Date().toLocaleTimeString('en-US', { hour12: false });
    const catSummary = categories
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 4)
      .map(c => `${c.name}: ${c.score}`)
      .join(', ');

    const gradeColor = overallScore >= 70 ? chalk.green : overallScore >= 50 ? chalk.yellow : chalk.red;
    console.log(`  ${chalk.dim(`[${time}]`)} Score: ${gradeColor(`${overallScore}/100 (${grade})`)} — ${catSummary}`);
  } catch (error) {
    const time = new Date().toLocaleTimeString('en-US', { hour12: false });
    console.log(`  ${chalk.dim(`[${time}]`)} ${chalk.red('Analysis error:')} ${error instanceof Error ? error.message : error}`);
  }
}
