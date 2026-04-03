import { Command } from 'commander';
import { resolve } from 'node:path';

const program = new Command();

program
  .name('llm-sense')
  .description('Analyze how LLM-friendly a codebase is')
  .version('0.8.0')
  .option('--path <dir>', 'Path to the codebase to analyze', '.')
  .option('--bugs <n>', 'Number of synthetic bug tasks', '5')
  .option('--features <n>', 'Number of synthetic feature tasks', '5')
  .option('--output <file>', 'Output report file path', 'llm-sense-report.md')
  .option('--max-budget-per-task <usd>', 'Max USD per empirical task', '1.00')
  .option('--max-turns-per-task <n>', 'Max turns per empirical task', '30')
  .option('--skip-empirical', 'Skip empirical testing (faster, cheaper, less accurate)')
  .option('--concurrency <n>', 'Max parallel empirical tasks (default: auto)')
  .option('--model <model>', 'Override Claude model for all phases')
  .option('--verbose', 'Show detailed progress output')
  .option('--history', 'Show score history for the target codebase')
  .option('--format <format>', 'Output format: markdown, json, summary', 'markdown')
  .option('--min-score <number>', 'Minimum passing score (exit 1 if below)')
  .option('--badge <path>', 'Generate an SVG score badge at the given path')
  .option('--fix', 'Auto-fix top recommendation using Claude Code')
  .option('--fix-count <n>', 'Number of recommendations to fix', '1')
  .option('--fix-id <id>', 'Fix a specific recommendation by ID')
  .option('--dry-run', 'With --fix: preview changes without applying')
  .option('--fix-continue', 'With --fix: continue on failure instead of stopping')
  .option('--yes', 'Skip confirmation prompts')
  .option('--plan', 'Show progressive improvement plan')
  .option('--compare <path>', 'Compare with another codebase')
  .option('--trend', 'Show score trend chart from history')
  .option('-i, --interactive', 'Interactive mode after analysis')
  .option('--watch', 'Watch for changes and re-score (static only)')
  .action(async (options) => {
    const targetPath = resolve(options.path);

    if (options.history) {
      const { loadHistory, formatHistoryTable } = await import('./core/history.js');
      const history = await loadHistory(targetPath);
      console.log(formatHistoryTable(history));
      return;
    }

    if (options.trend) {
      const { loadHistory } = await import('./core/history.js');
      const { formatTrendChart } = await import('./report/trend.js');
      const history = await loadHistory(targetPath);
      console.log(formatTrendChart(history));
      return;
    }

    if (options.watch) {
      const { runWatch } = await import('./watch.js');
      await runWatch(targetPath);
      return;
    }

    const format = options.format ?? 'markdown';
    if (!['markdown', 'json', 'summary'].includes(format)) {
      console.error(`Error: Invalid format "${format}". Must be markdown, json, or summary.`);
      process.exit(2);
    }

    const { run } = await import('./phases/runner.js');
    await run({
      path: targetPath,
      bugs: parseInt(options.bugs, 10),
      features: parseInt(options.features, 10),
      output: options.output,
      maxBudgetPerTask: parseFloat(options.maxBudgetPerTask),
      maxTurnsPerTask: parseInt(options.maxTurnsPerTask, 10),
      skipEmpirical: options.skipEmpirical ?? false,
      concurrency: options.concurrency ? parseInt(options.concurrency, 10) : undefined,
      model: options.model,
      verbose: options.verbose ?? false,
      history: options.history ?? false,
      format: format as 'markdown' | 'json' | 'summary',
      minScore: options.minScore ? parseInt(options.minScore, 10) : undefined,
      badge: options.badge,
      fix: options.fix ?? false,
      fixCount: parseInt(options.fixCount, 10),
      fixId: options.fixId,
      dryRun: options.dryRun ?? false,
      fixContinue: options.fixContinue ?? false,
      yes: options.yes ?? false,
      plan: options.plan ?? false,
      compare: options.compare ? resolve(options.compare) : undefined,
      interactive: options.interactive ?? false,
    });
  });

// init subcommand — uses argument instead of --path to avoid conflict with parent option
program
  .command('init [dir]')
  .description('Scaffold AI config files (CLAUDE.md, .cursorrules, etc.)')
  .option('--verbose', 'Show detailed output')
  .action(async (dir, options) => {
    const targetPath = resolve(dir ?? '.');
    const { runInit } = await import('./commands/init.js');
    await runInit(targetPath, options.verbose ?? false);
  });

async function main() {
  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    if (error instanceof Error) {
      console.error(`\n  Error: ${error.message}`);
      process.exit(2);
    }
    throw error;
  }
}

main();
