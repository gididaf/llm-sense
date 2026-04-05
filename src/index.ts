import { Command } from 'commander';
import { resolve } from 'node:path';

const program = new Command();

program
  .name('llm-sense')
  .description('Analyze how LLM-friendly a codebase is')
  .version('2.4.0')
  .enablePositionalOptions()
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
  .option('--format <format>', 'Output format: markdown, json, summary, html', 'markdown')
  .option('--min-score <number>', 'Minimum passing score (exit 1 if below)')
  .option('--badge <path>', 'Generate an SVG score badge at the given path')
  .option('--fix', 'Auto-fix top recommendation using Claude Code')
  .option('--fix-count <n>', 'Number of recommendations to fix', '1')
  .option('--fix-id <id>', 'Fix a specific recommendation by ID')
  .option('--dry-run', 'With --fix: preview changes without applying')
  .option('--fix-continue', 'With --fix: continue on failure instead of stopping')
  .option('--yes', 'Skip confirmation prompts')
  .option('--compare <path>', 'Compare with another codebase')
  .option('--trend', 'Show score trend chart from history')
  .option('-i, --interactive', 'Interactive mode after analysis')
  .option('--watch', 'Watch for changes and re-score (static only)')
  .option('--monorepo', 'Force per-package monorepo analysis')
  .option('--no-monorepo', 'Skip monorepo detection, analyze as single repo')
  .option('--no-cache', 'Force full re-analysis, ignoring cached results')
  .option('--pr-delta', 'Predict score impact of changed files only (fast CI mode)')
  .option('--auto-improve', 'Auto-improve loop: keep fixing until target score is reached')
  .option('--target <score>', 'Target score for --auto-improve (required with --auto-improve)')
  .option('--max-iterations <n>', 'Max fix cycles for --auto-improve', '10')
  .option('--max-total-budget <usd>', 'Total budget cap for --auto-improve', '5.00')
  .option('--profile <name>', 'Scoring profile: default, strict, docs, security, or path to .llm-sense/profile.json')
  .option('--no-ast', 'Skip tree-sitter AST analysis (use regex-only language checks)')
  .option('--git-history', 'Enrich analysis with git history data (file importance, hotspots, bus factor)')
  .option('--annotations', 'Include file-level annotations in JSON output (for CI/GitHub Action inline comments)')
  .option('--generate-ignore', 'Auto-create .claudeignore, .cursorignore, .copilotignore files based on analysis')
  .option('--no-llm-lint', 'Skip LLM-powered lint rules (reduces cost during non-empirical runs)')
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
    if (!['markdown', 'json', 'summary', 'html'].includes(format)) {
      console.error(`Error: Invalid format "${format}". Must be markdown, json, summary, or html.`);
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
      format: format as 'markdown' | 'json' | 'summary' | 'html',
      minScore: options.minScore ? parseInt(options.minScore, 10) : undefined,
      badge: options.badge,
      fix: options.fix ?? false,
      fixCount: parseInt(options.fixCount, 10),
      fixId: options.fixId,
      dryRun: options.dryRun ?? false,
      fixContinue: options.fixContinue ?? false,
      yes: options.yes ?? false,
      plan: false,
      compare: options.compare ? resolve(options.compare) : undefined,
      interactive: options.interactive ?? false,
      monorepo: options.monorepo === true,
      noMonorepo: options.monorepo === false,
      noCache: options.cache === false,
      prDelta: options.prDelta ?? false,
      autoImprove: options.autoImprove ?? false,
      target: options.target ? parseInt(options.target, 10) : undefined,
      maxIterations: parseInt(options.maxIterations, 10),
      maxTotalBudget: parseFloat(options.maxTotalBudget),
      profile: options.profile,
      noAst: options.ast === false,
      gitHistory: options.gitHistory ?? false,
      annotations: options.annotations ?? false,
      generateIgnore: options.generateIgnore ?? false,
      noLlmLint: options.llmLint === false,
    });
  });

// init subcommand — uses argument instead of --path to avoid conflict with parent option
program
  .command('serve')
  .description('Start MCP server for real-time AI tool integration (stdin/stdout JSON-RPC)')
  .action(async () => {
    const { startMcpServer } = await import('./mcp/server.js');
    await startMcpServer();
  });

program
  .command('audit [dir]')
  .description('Audit AI config files for quality, accuracy, and freshness')
  .passThroughOptions()
  .option('--verbose', 'Show detailed findings per dimension')
  .option('--format <format>', 'Output format: console, json', 'console')
  .action(async (dir, options) => {
    const targetPath = resolve(dir ?? '.');
    const { runAudit } = await import('./commands/audit.js');
    await runAudit(targetPath, {
      verbose: options.verbose ?? false,
      format: (options.format === 'json' ? 'json' : 'console') as 'console' | 'json',
    });
  });

program
  .command('init [dir]')
  .description('Scaffold AI config files for 30+ tools (CLAUDE.md, .cursorrules, .windsurfrules, ...)')
  .option('--verbose', 'Show detailed output')
  .option('--overwrite', 'Overwrite existing config files')
  .option('--tools <ids>', 'Generate only specific tools (comma-separated IDs)')
  .option('--list', 'List all supported AI tool config formats')
  .option('--detect', 'Detect existing configs and generate missing ones')
  .option('--provider <name>', 'LLM provider for AI-powered generation: claude, openai, google')
  .action(async (dir, options) => {
    const targetPath = resolve(dir ?? '.');
    const { runInit } = await import('./commands/init.js');
    await runInit(targetPath, options.verbose ?? false, options.overwrite ?? false, {
      tools: options.tools ? options.tools.split(',').map((s: string) => s.trim()) : undefined,
      list: options.list ?? false,
      detect: options.detect ?? false,
      provider: options.provider,
    });
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
