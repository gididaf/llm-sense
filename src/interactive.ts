import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import chalk from 'chalk';
import type { FinalReport, CliOptions, ExecutableRecommendation } from './types.js';
import { generateReport } from './report/generator.js';
import { generatePlan } from './report/recommendations.js';
import { buildJsonOutput } from './report/jsonOutput.js';

function prompt(rl: ReturnType<typeof createInterface>, message: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(message, (answer) => resolve(answer.trim()));
  });
}

export async function runInteractive(
  report: FinalReport,
  recommendations: ExecutableRecommendation[],
  options: CliOptions,
): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log('');
  console.log(chalk.bold(`  Analysis complete: ${report.overallScore}/100 (${report.grade})`));

  let running = true;
  while (running) {
    console.log('');
    console.log('  What would you like to do?');
    console.log(`    ${chalk.bold('[1]')} View full report`);
    if (recommendations.length > 0) {
      const top = recommendations[0];
      console.log(`    ${chalk.bold('[2]')} View top recommendation (+${top.estimatedScoreImpact} pts: ${top.title.slice(0, 40)}...)`);
    }
    console.log(`    ${chalk.bold('[3]')} View improvement plan`);
    console.log(`    ${chalk.bold('[4]')} Export JSON`);
    console.log(`    ${chalk.bold('[5]')} Show category breakdown`);
    console.log(`    ${chalk.bold('[q]')} Quit`);
    console.log('');

    const choice = await prompt(rl, '  > ');

    switch (choice) {
      case '1': {
        const reportContent = generateReport(report);
        const outputPath = resolve(options.output);
        await writeFile(outputPath, reportContent, 'utf-8');
        console.log(chalk.green(`  Report saved to ${outputPath}`));
        break;
      }
      case '2': {
        if (recommendations.length === 0) {
          console.log(chalk.dim('  No recommendations available.'));
          break;
        }
        const rec = recommendations[0];
        console.log('');
        console.log(chalk.bold(`  ${rec.title}`));
        console.log(chalk.dim(`  Priority ${rec.priority} | +${rec.estimatedScoreImpact} pts | ${rec.estimatedEffort}`));
        console.log('');
        console.log(`  ${chalk.underline('Current State')}`);
        console.log(`  ${rec.currentState}`);
        console.log('');
        console.log(`  ${chalk.underline('Steps')}`);
        for (let i = 0; i < rec.implementationSteps.length; i++) {
          console.log(`  ${i + 1}. ${rec.implementationSteps[i]}`);
        }
        if (rec.draftContent) {
          console.log('');
          console.log(chalk.dim('  Draft content available — export the full report to view it.'));
        }
        break;
      }
      case '3': {
        console.log(generatePlan(recommendations, report.overallScore, report.targetPath));
        break;
      }
      case '4': {
        const jsonOutput = buildJsonOutput(report, report.taskResults.length > 0 ? 'full' : 'static-only', options.model);
        const jsonPath = resolve('llm-sense-output.json');
        await writeFile(jsonPath, JSON.stringify(jsonOutput, null, 2) + '\n', 'utf-8');
        console.log(chalk.green(`  JSON exported to ${jsonPath}`));
        break;
      }
      case '5': {
        console.log('');
        for (const cat of [...report.categories].sort((a, b) => a.score - b.score)) {
          const filled = Math.round(cat.score / 5);
          const empty = 20 - filled;
          const color = cat.score >= 70 ? chalk.green : cat.score >= 50 ? chalk.yellow : chalk.red;
          console.log(`  ${color('█'.repeat(filled))}${chalk.dim('░'.repeat(empty))} ${String(cat.score).padStart(3)} ${cat.name}`);
          for (const f of cat.findings) {
            console.log(chalk.dim(`       ${f}`));
          }
        }
        break;
      }
      case 'q':
      case 'quit':
      case 'exit':
        running = false;
        break;
      default:
        console.log(chalk.dim('  Invalid choice. Enter 1-5 or q.'));
    }
  }

  rl.close();
}
