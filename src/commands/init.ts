import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import chalk from 'chalk';
import { runStaticAnalysis } from '../phases/staticAnalysis.js';
import type { StaticAnalysisResult } from '../types.js';

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function generateClaudeMdFromStatic(staticResult: StaticAnalysisResult, targetPath: string): string {
  const projectName = targetPath.split('/').pop() ?? 'Project';
  const lines: string[] = [];

  lines.push(`# ${projectName}`);
  lines.push('');
  lines.push('## Architecture Overview');
  lines.push('');
  lines.push('<!-- TODO: Describe the high-level architecture and data flow -->');
  lines.push('');

  // Tech stack detection from file extensions
  const techStack: string[] = [];
  const doc = staticResult.documentation;

  // Infer from directory entries and file types
  if (staticResult.fileSizes.largestFiles.some(f => f.path.endsWith('.ts') || f.path.endsWith('.tsx'))) {
    techStack.push('TypeScript');
  }
  if (staticResult.fileSizes.largestFiles.some(f => f.path.endsWith('.py'))) {
    techStack.push('Python');
  }
  if (staticResult.fileSizes.largestFiles.some(f => f.path.endsWith('.go'))) {
    techStack.push('Go');
  }
  if (staticResult.fileSizes.largestFiles.some(f => f.path.endsWith('.rs'))) {
    techStack.push('Rust');
  }

  if (techStack.length > 0) {
    lines.push('## Tech Stack');
    lines.push('');
    for (const tech of techStack) {
      lines.push(`- **${tech}**`);
    }
    lines.push('');
  }

  lines.push('## Module Map');
  lines.push('');
  lines.push('```');
  // Simple directory listing from structure analysis
  lines.push(`${projectName}/`);
  lines.push('├── ... (fill in key directories and their purposes)');
  lines.push('```');
  lines.push('');

  lines.push('## Common Patterns');
  lines.push('');
  lines.push('<!-- TODO: Add "how to add a new X" examples for common operations -->');
  lines.push('');

  lines.push('## Testing');
  lines.push('');
  if (staticResult.devInfra.hasTestCommand) {
    lines.push('```bash');
    lines.push('# TODO: Add test command');
    lines.push('```');
  } else {
    lines.push('<!-- TODO: Add testing approach and commands -->');
  }
  lines.push('');

  lines.push('## Build / Run / Deploy');
  lines.push('');
  lines.push('```bash');
  lines.push('# TODO: Add build/run/deploy commands');
  lines.push('```');
  lines.push('');

  lines.push('## Gotchas');
  lines.push('');
  lines.push('<!-- TODO: Add pitfalls, caveats, and things to watch out for -->');
  lines.push('');

  lines.push('## Environment Setup');
  lines.push('');
  lines.push('```bash');
  lines.push('# TODO: Add environment setup instructions');
  lines.push('```');
  lines.push('');

  return lines.join('\n');
}

function generateCursorRules(staticResult: StaticAnalysisResult, targetPath: string): string {
  const projectName = targetPath.split('/').pop() ?? 'Project';
  const lines: string[] = [];

  lines.push(`# ${projectName} - Cursor Rules`);
  lines.push('');
  lines.push('## Project Context');
  lines.push(`This is the ${projectName} project.`);
  lines.push('');
  lines.push('## Coding Conventions');
  lines.push(`- Naming: ${staticResult.naming.dominantConvention}`);
  lines.push(`- File structure: ${staticResult.directoryStructure.maxDepth} levels deep, avg ${staticResult.directoryStructure.avgFilesPerDir} files/dir`);
  lines.push('');
  lines.push('## Important Files');
  lines.push('<!-- TODO: List key entry points and configuration files -->');
  lines.push('');
  lines.push('## Rules');
  lines.push('- Follow existing naming conventions');
  lines.push('- Keep files under 300 lines when possible');
  lines.push('- Add inline comments for non-obvious logic');
  lines.push('');

  return lines.join('\n');
}

function generateCopilotInstructions(staticResult: StaticAnalysisResult, targetPath: string): string {
  const projectName = targetPath.split('/').pop() ?? 'Project';
  const lines: string[] = [];

  lines.push(`# ${projectName} - Copilot Instructions`);
  lines.push('');
  lines.push('## Project Overview');
  lines.push(`This is the ${projectName} project.`);
  lines.push('');
  lines.push('## Conventions');
  lines.push(`- File naming: ${staticResult.naming.dominantConvention}`);
  lines.push('- Keep functions focused and files small');
  lines.push('');
  lines.push('## Architecture');
  lines.push('<!-- TODO: Describe the project architecture -->');
  lines.push('');

  return lines.join('\n');
}

export async function runInit(targetPath: string, verbose: boolean): Promise<void> {
  console.log('');
  console.log(chalk.bold('  llm-sense init') + ' — Scaffolding AI config files');
  console.log(chalk.dim(`  Target: ${targetPath}`));
  console.log('');

  // Run Phase 1 for context
  console.log(chalk.dim('  Analyzing codebase...'));
  const { result: staticResult } = await runStaticAnalysis(targetPath, verbose);
  console.log(chalk.green('  ✓') + ` ${staticResult.fileSizes.totalFiles} files analyzed`);
  console.log('');

  let filesCreated = 0;

  // CLAUDE.md — always generate if missing
  const claudeMdPath = join(targetPath, 'CLAUDE.md');
  if (await fileExists(claudeMdPath)) {
    console.log(chalk.dim('  CLAUDE.md already exists — skipping'));
  } else {
    const content = generateClaudeMdFromStatic(staticResult, targetPath);
    await writeFile(claudeMdPath, content, 'utf-8');
    console.log(chalk.green('  ✓') + ` Created ${chalk.underline('CLAUDE.md')}`);
    filesCreated++;
  }

  // .cursorrules — only if Cursor is detected or no AI config exists
  const vc = staticResult.documentation.vibeCoderContext;
  const cursorRulesPath = join(targetPath, '.cursorrules');
  if (vc.hasCursorRules) {
    console.log(chalk.dim('  .cursorrules already exists — skipping'));
  } else if (vc.hasCursorIgnore || !vc.hasCopilotInstructions) {
    // Cursor is used (has .cursorignore) or no other AI tool detected
    const content = generateCursorRules(staticResult, targetPath);
    await writeFile(cursorRulesPath, content, 'utf-8');
    console.log(chalk.green('  ✓') + ` Created ${chalk.underline('.cursorrules')}`);
    filesCreated++;
  }

  // .github/copilot-instructions.md — only if Copilot is detected
  const copilotPath = join(targetPath, '.github', 'copilot-instructions.md');
  if (vc.hasCopilotInstructions) {
    console.log(chalk.dim('  copilot-instructions.md already exists — skipping'));
  } else if (await fileExists(join(targetPath, '.github'))) {
    // .github directory exists = likely using GitHub = generate copilot instructions
    const content = generateCopilotInstructions(staticResult, targetPath);
    await writeFile(copilotPath, content, 'utf-8');
    console.log(chalk.green('  ✓') + ` Created ${chalk.underline('.github/copilot-instructions.md')}`);
    filesCreated++;
  }

  console.log('');
  if (filesCreated > 0) {
    console.log(chalk.bold(`  ${filesCreated} file${filesCreated > 1 ? 's' : ''} created.`) + ' Review and fill in the TODO sections.');
  } else {
    console.log(chalk.dim('  All config files already exist. Nothing to do.'));
  }
  console.log(chalk.dim('  Run `llm-sense --skip-empirical` to see your updated score.'));
  console.log('');
}
