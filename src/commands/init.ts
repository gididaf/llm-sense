import { access, writeFile, readFile, mkdir } from 'node:fs/promises';
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

// Detect tech stack from file extensions + dependency files
function detectTechStack(staticResult: StaticAnalysisResult, targetPath: string): string[] {
  const stack: string[] = [];
  const files = staticResult.fileSizes.largestFiles;

  if (files.some(f => f.path.endsWith('.ts') || f.path.endsWith('.tsx'))) stack.push('TypeScript');
  else if (files.some(f => f.path.endsWith('.js') || f.path.endsWith('.jsx'))) stack.push('JavaScript');
  if (files.some(f => f.path.endsWith('.py'))) stack.push('Python');
  if (files.some(f => f.path.endsWith('.go'))) stack.push('Go');
  if (files.some(f => f.path.endsWith('.rs'))) stack.push('Rust');
  if (files.some(f => f.path.endsWith('.java') || f.path.endsWith('.kt'))) stack.push('Java/Kotlin');
  if (files.some(f => f.path.endsWith('.rb'))) stack.push('Ruby');
  if (files.some(f => f.path.endsWith('.php'))) stack.push('PHP');
  if (files.some(f => f.path.endsWith('.cs'))) stack.push('C#');
  if (files.some(f => f.path.endsWith('.swift'))) stack.push('Swift');

  return stack;
}

// Detect framework from file patterns
async function detectFramework(targetPath: string): Promise<string[]> {
  const frameworks: string[] = [];

  try {
    const pkg = JSON.parse(await readFile(join(targetPath, 'package.json'), 'utf-8'));
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

    if (allDeps['next']) frameworks.push('Next.js');
    else if (allDeps['react']) frameworks.push('React');
    if (allDeps['vue']) frameworks.push('Vue');
    if (allDeps['svelte'] || allDeps['@sveltejs/kit']) frameworks.push('Svelte');
    if (allDeps['express']) frameworks.push('Express');
    if (allDeps['fastify']) frameworks.push('Fastify');
    if (allDeps['@nestjs/core']) frameworks.push('NestJS');
    if (allDeps['astro']) frameworks.push('Astro');
  } catch {}

  // Python frameworks
  try {
    const req = await readFile(join(targetPath, 'requirements.txt'), 'utf-8');
    if (req.includes('django')) frameworks.push('Django');
    if (req.includes('flask')) frameworks.push('Flask');
    if (req.includes('fastapi')) frameworks.push('FastAPI');
  } catch {}

  return frameworks;
}

// Detect build/test/run commands from project files
async function detectCommands(targetPath: string): Promise<{ build?: string; test?: string; dev?: string; install?: string }> {
  const cmds: { build?: string; test?: string; dev?: string; install?: string } = {};

  try {
    const pkg = JSON.parse(await readFile(join(targetPath, 'package.json'), 'utf-8'));
    const scripts = pkg.scripts ?? {};
    if (scripts.build) cmds.build = `npm run build`;
    if (scripts.test && scripts.test !== 'echo "Error: no test specified" && exit 1') cmds.test = `npm test`;
    if (scripts.dev || scripts.start) cmds.dev = scripts.dev ? 'npm run dev' : 'npm start';
    cmds.install = 'npm install';
  } catch {}

  if (!cmds.install && await fileExists(join(targetPath, 'requirements.txt'))) {
    cmds.install = 'pip install -r requirements.txt';
  }
  if (!cmds.install && await fileExists(join(targetPath, 'go.mod'))) {
    cmds.install = 'go mod download';
    cmds.build = cmds.build ?? 'go build ./...';
    cmds.test = cmds.test ?? 'go test ./...';
  }

  return cmds;
}

function detectTestingFramework(staticResult: StaticAnalysisResult): string | null {
  if (staticResult.devInfra.hasTestCommand) {
    const ciContent = staticResult.devInfra.ciFiles.join(' ').toLowerCase();
    if (ciContent.includes('jest')) return 'Jest';
    if (ciContent.includes('vitest')) return 'Vitest';
    if (ciContent.includes('pytest')) return 'pytest';
    if (ciContent.includes('playwright')) return 'Playwright';
  }
  return null;
}

function generateClaudeMdFromStatic(
  staticResult: StaticAnalysisResult,
  targetPath: string,
  techStack: string[],
  frameworks: string[],
  commands: { build?: string; test?: string; dev?: string; install?: string },
): string {
  const projectName = targetPath.split('/').pop() ?? 'Project';
  const lines: string[] = [];

  lines.push(`# ${projectName}`);
  lines.push('');
  lines.push('## Architecture Overview');
  lines.push('');
  lines.push('<!-- TODO: Describe the high-level architecture and data flow -->');
  lines.push('');

  if (techStack.length > 0 || frameworks.length > 0) {
    lines.push('## Tech Stack');
    lines.push('');
    for (const tech of techStack) lines.push(`- **${tech}**`);
    for (const fw of frameworks) lines.push(`- **${fw}**`);
    lines.push('');
  }

  lines.push('## Module Map');
  lines.push('');
  lines.push('```');
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
  if (commands.test) {
    lines.push('```bash');
    lines.push(commands.test);
    lines.push('```');
  } else {
    lines.push('<!-- TODO: Add testing approach and commands -->');
  }
  lines.push('');

  lines.push('## Build / Run / Deploy');
  lines.push('');
  lines.push('```bash');
  if (commands.install) lines.push(commands.install);
  if (commands.build) lines.push(commands.build);
  if (commands.dev) lines.push(commands.dev);
  if (!commands.install && !commands.build && !commands.dev) {
    lines.push('# TODO: Add build/run/deploy commands');
  }
  lines.push('```');
  lines.push('');

  lines.push('## Gotchas');
  lines.push('');
  lines.push('<!-- TODO: Add pitfalls, caveats, and things to watch out for -->');
  lines.push('');

  lines.push('## Environment Setup');
  lines.push('');
  lines.push('```bash');
  if (commands.install) {
    lines.push(commands.install);
  } else {
    lines.push('# TODO: Add environment setup instructions');
  }
  lines.push('```');
  lines.push('');

  return lines.join('\n');
}

function generateCursorRules(
  staticResult: StaticAnalysisResult,
  targetPath: string,
  techStack: string[],
  frameworks: string[],
  commands: { build?: string; test?: string; dev?: string; install?: string },
): string {
  const projectName = targetPath.split('/').pop() ?? 'Project';
  const lines: string[] = [];

  lines.push(`# ${projectName} - Cursor Rules`);
  lines.push('');
  lines.push('## Project Context');
  const stackDesc = [...techStack, ...frameworks].join(', ');
  lines.push(`This is the ${projectName} project${stackDesc ? ` built with ${stackDesc}` : ''}.`);
  lines.push('');
  lines.push('## Coding Conventions');
  lines.push(`- Naming: ${staticResult.naming.dominantConvention}`);
  lines.push(`- File structure: ${staticResult.directoryStructure.maxDepth} levels deep, avg ${staticResult.directoryStructure.avgFilesPerDir} files/dir`);
  lines.push('');
  lines.push('## Important Files');
  lines.push('<!-- TODO: List key entry points and configuration files -->');
  lines.push('');
  if (commands.build || commands.test) {
    lines.push('## Commands');
    if (commands.build) lines.push(`- Build: \`${commands.build}\``);
    if (commands.test) lines.push(`- Test: \`${commands.test}\``);
    if (commands.dev) lines.push(`- Dev: \`${commands.dev}\``);
    lines.push('');
  }
  lines.push('## Rules');
  lines.push('- Follow existing naming conventions');
  lines.push('- Keep files under 300 lines when possible');
  lines.push('- Add inline comments for non-obvious logic');
  lines.push('');

  return lines.join('\n');
}

function generateCopilotInstructions(
  staticResult: StaticAnalysisResult,
  targetPath: string,
  techStack: string[],
  frameworks: string[],
  commands: { build?: string; test?: string; dev?: string; install?: string },
): string {
  const projectName = targetPath.split('/').pop() ?? 'Project';
  const lines: string[] = [];
  const stackDesc = [...techStack, ...frameworks].join(', ');

  lines.push(`# ${projectName} - Copilot Instructions`);
  lines.push('');
  lines.push('## Project Overview');
  lines.push(`This is the ${projectName} project${stackDesc ? ` built with ${stackDesc}` : ''}.`);
  lines.push('');
  lines.push('## Conventions');
  lines.push(`- File naming: ${staticResult.naming.dominantConvention}`);
  lines.push('- Keep functions focused and files small');
  lines.push('');
  if (commands.build || commands.test) {
    lines.push('## Commands');
    if (commands.build) lines.push(`- Build: \`${commands.build}\``);
    if (commands.test) lines.push(`- Test: \`${commands.test}\``);
    if (commands.dev) lines.push(`- Dev: \`${commands.dev}\``);
    lines.push('');
  }
  lines.push('## Architecture');
  lines.push('<!-- TODO: Describe the project architecture -->');
  lines.push('');

  return lines.join('\n');
}

function generateAgentsMd(
  staticResult: StaticAnalysisResult,
  targetPath: string,
  techStack: string[],
  frameworks: string[],
): string {
  const projectName = targetPath.split('/').pop() ?? 'Project';
  const lines: string[] = [];
  const stackDesc = [...techStack, ...frameworks].join(', ');

  lines.push(`# ${projectName} - Agent Instructions`);
  lines.push('');
  lines.push('## Overview');
  lines.push(`${projectName} is a ${stackDesc || 'software'} project with ${staticResult.fileSizes.totalFiles} source files.`);
  lines.push('');
  lines.push('## Working with this Codebase');
  lines.push('');
  lines.push('### Key Directories');
  lines.push('<!-- TODO: Describe the purpose of each top-level directory -->');
  lines.push('');
  lines.push('### Making Changes');
  lines.push('- Read existing patterns before creating new files');
  lines.push('- Follow the dominant naming convention: ' + staticResult.naming.dominantConvention);
  lines.push('- Keep modules focused and files under 300 lines');
  lines.push('');
  lines.push('### Testing');
  if (staticResult.devInfra.hasTestCommand) {
    lines.push('- Always run tests after making changes');
  } else {
    lines.push('- <!-- TODO: Add testing instructions -->');
  }
  lines.push('');
  lines.push('### Common Pitfalls');
  lines.push('<!-- TODO: Add module-specific pitfalls and gotchas -->');
  lines.push('');

  return lines.join('\n');
}

export async function runInit(targetPath: string, verbose: boolean, overwrite: boolean = false): Promise<void> {
  console.log('');
  console.log(chalk.bold('  llm-sense init') + ' — Scaffolding AI config files');
  console.log(chalk.dim(`  Target: ${targetPath}`));
  if (overwrite) console.log(chalk.yellow('  --overwrite: will replace existing files'));
  console.log('');

  // Run Phase 1 for context
  console.log(chalk.dim('  Analyzing codebase...'));
  const { result: staticResult } = await runStaticAnalysis(targetPath, verbose);
  console.log(chalk.green('  ✓') + ` ${staticResult.fileSizes.totalFiles} files analyzed`);

  // Detect tech stack, frameworks, commands
  const techStack = detectTechStack(staticResult, targetPath);
  const frameworks = await detectFramework(targetPath);
  const commands = await detectCommands(targetPath);

  if (techStack.length > 0 || frameworks.length > 0) {
    console.log(chalk.dim(`  Detected: ${[...techStack, ...frameworks].join(', ')}`));
  }
  console.log('');

  let filesCreated = 0;

  async function writeConfig(filePath: string, label: string, content: string): Promise<void> {
    if (await fileExists(filePath) && !overwrite) {
      console.log(chalk.dim(`  ${label} already exists — skipping (use --overwrite to replace)`));
      return;
    }
    // Ensure parent directory exists
    const dir = filePath.substring(0, filePath.lastIndexOf('/'));
    if (dir !== targetPath) {
      await mkdir(dir, { recursive: true });
    }
    await writeFile(filePath, content, 'utf-8');
    const verb = (await fileExists(filePath)) ? 'Created' : 'Updated';
    console.log(chalk.green('  ✓') + ` ${verb} ${chalk.underline(label)}`);
    filesCreated++;
  }

  // CLAUDE.md — always generate
  await writeConfig(
    join(targetPath, 'CLAUDE.md'),
    'CLAUDE.md',
    generateClaudeMdFromStatic(staticResult, targetPath, techStack, frameworks, commands),
  );

  // .cursorrules — always generate (Cursor is dominant)
  await writeConfig(
    join(targetPath, '.cursorrules'),
    '.cursorrules',
    generateCursorRules(staticResult, targetPath, techStack, frameworks, commands),
  );

  // .github/copilot-instructions.md — generate if .github/ exists or create it
  if (await fileExists(join(targetPath, '.github')) || await fileExists(join(targetPath, '.git'))) {
    await writeConfig(
      join(targetPath, '.github', 'copilot-instructions.md'),
      '.github/copilot-instructions.md',
      generateCopilotInstructions(staticResult, targetPath, techStack, frameworks, commands),
    );
  }

  // AGENTS.md — always generate
  await writeConfig(
    join(targetPath, 'AGENTS.md'),
    'AGENTS.md',
    generateAgentsMd(staticResult, targetPath, techStack, frameworks),
  );

  console.log('');
  if (filesCreated > 0) {
    console.log(chalk.bold(`  ${filesCreated} file${filesCreated > 1 ? 's' : ''} created.`) + ' Review and fill in the TODO sections.');
  } else {
    console.log(chalk.dim('  All config files already exist. Use --overwrite to replace them.'));
  }
  console.log(chalk.dim('  Run `llm-sense --skip-empirical` to see your updated score.'));
  console.log('');
}
