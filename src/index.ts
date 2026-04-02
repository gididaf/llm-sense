import { Command } from 'commander';
import { resolve } from 'node:path';

const program = new Command();

program
  .name('llm-sense')
  .description('Analyze how LLM-friendly a codebase is')
  .version('0.2.1')
  .option('--path <dir>', 'Path to the codebase to analyze', '.')
  .option('--bugs <n>', 'Number of synthetic bug tasks', '5')
  .option('--features <n>', 'Number of synthetic feature tasks', '5')
  .option('--output <file>', 'Output report file path', 'llm-sense-report.md')
  .option('--max-budget-per-task <usd>', 'Max USD per empirical task', '1.00')
  .option('--max-turns-per-task <n>', 'Max turns per empirical task', '30')
  .option('--skip-empirical', 'Skip empirical testing (faster, cheaper, less accurate)')
  .option('--model <model>', 'Override Claude model for all phases')
  .option('--verbose', 'Show detailed progress output')
  .option('--history', 'Show score history for the target codebase')
  .action(async (options) => {
    const targetPath = resolve(options.path);

    if (options.history) {
      const { loadHistory, formatHistoryTable } = await import('./core/history.js');
      const history = await loadHistory(targetPath);
      console.log(formatHistoryTable(history));
      return;
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
      model: options.model,
      verbose: options.verbose ?? false,
      history: options.history ?? false,
    });
  });

async function main() {
  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    if (error instanceof Error) {
      console.error(`\n  Error: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}

main();
