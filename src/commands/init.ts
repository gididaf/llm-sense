import { access, writeFile, readFile, mkdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import chalk from 'chalk';
import { runStaticAnalysis } from '../phases/staticAnalysis.js';
import { isClaudeInstalled, callClaudeStructured } from '../core/claude.js';
import { buildDirectorySummary, stratifiedSample, readFileSafe, getSourceFiles } from '../core/fs.js';
import type { WalkEntry } from '../core/fs.js';
import { ClaudeMdSectionsSchema, CursorRulesSectionsSchema, CopilotInstructionsSectionsSchema, AgentsMdSectionsSchema } from '../types.js';
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

// ─── AI-Powered Generation (Claude CLI) ────────────────

async function buildCodebaseContext(
  targetPath: string,
  entries: WalkEntry[],
  techStack: string[],
  frameworks: string[],
  commands: { build?: string; test?: string; dev?: string; install?: string },
): Promise<string> {
  const sourceFiles = getSourceFiles(entries);
  const tree = buildDirectorySummary(sourceFiles);
  const sampleFiles = stratifiedSample(sourceFiles, 30);
  const sampleContents = await Promise.all(
    sampleFiles.map(async f => ({
      path: f.relativePath,
      content: await readFileSafe(f.path, 10_000), // ~200 lines
    })),
  );

  return `## Codebase Context
- Tech stack: ${techStack.join(', ') || 'unknown'}
- Frameworks: ${frameworks.join(', ') || 'none detected'}
- Commands: build=${commands.build || 'unknown'}, test=${commands.test || 'unknown'}, dev=${commands.dev || 'unknown'}
- File count: ${sourceFiles.length} source files

## Directory Structure
${tree}

## Sample Files (${sampleFiles.length} representative files):
${sampleContents.map(f => `### ${f.path}\n\`\`\`\n${f.content.slice(0, 3000)}\n\`\`\``).join('\n\n')}`;
}

async function generateClaudeMdWithClaude(
  targetPath: string,
  entries: WalkEntry[],
  techStack: string[],
  frameworks: string[],
  commands: { build?: string; test?: string; dev?: string; install?: string },
): Promise<string> {
  const context = await buildCodebaseContext(targetPath, entries, techStack, frameworks, commands);
  const prompt = `You are analyzing a codebase to generate a comprehensive CLAUDE.md file.

${context}

## Task
Write a CLAUDE.md file with these 8 sections. Each section must contain REAL, SPECIFIC content about THIS codebase — not generic placeholders.

1. **Architecture Overview** — How the system is structured, what the main components are, how data flows
2. **Module Map** — Directory tree with descriptions of what each top-level directory contains
3. **Common Patterns** — How to add a new feature, new API endpoint, new test, etc. in this specific codebase
4. **Testing** — What testing framework is used, how to run tests, how to write new tests
5. **Build / Run / Deploy** — Exact commands to build, run, test, deploy
6. **Gotchas** — Things that would surprise a new developer or trip up an AI coding assistant
7. **Tech Stack** — Languages, frameworks, libraries, and their versions
8. **Environment Setup** — How to set up a development environment from scratch

Be specific. Reference actual file paths, actual function names, actual patterns from the sample files.`;

  const { data } = await callClaudeStructured(
    { prompt, cwd: targetPath, timeout: 120_000 },
    ClaudeMdSectionsSchema,
  );

  const projectName = basename(targetPath);
  return [
    `# ${projectName}`, '',
    '## Architecture Overview', '', data.architectureOverview, '',
    '## Module Map', '', data.moduleMap, '',
    '## Common Patterns', '', data.commonPatterns, '',
    '## Testing', '', data.testing, '',
    '## Build / Run / Deploy', '', data.buildRunDeploy, '',
    '## Gotchas', '', data.gotchas, '',
    '## Tech Stack', '', data.techStack, '',
    '## Environment Setup', '', data.environmentSetup, '',
  ].join('\n');
}

async function generateCursorRulesWithClaude(
  targetPath: string,
  entries: WalkEntry[],
  techStack: string[],
  frameworks: string[],
  commands: { build?: string; test?: string; dev?: string; install?: string },
): Promise<string> {
  const context = await buildCodebaseContext(targetPath, entries, techStack, frameworks, commands);
  const prompt = `You are analyzing a codebase to generate a .cursorrules file for Cursor AI.

${context}

## Task
Generate a .cursorrules file with these sections. Be specific to THIS codebase, not generic.

1. **Project Context** — What this project does, key technologies
2. **Coding Conventions** — Naming, file structure, patterns used
3. **Important Files** — Key entry points, configs, and critical files
4. **Commands** — Build, test, run, deploy commands
5. **Rules** — Specific rules for working with this codebase`;

  const { data } = await callClaudeStructured(
    { prompt, cwd: targetPath, timeout: 120_000 },
    CursorRulesSectionsSchema,
  );

  const projectName = basename(targetPath);
  return [
    `# ${projectName} - Cursor Rules`, '',
    '## Project Context', '', data.projectContext, '',
    '## Coding Conventions', '', data.codingConventions, '',
    '## Important Files', '', data.importantFiles, '',
    '## Commands', '', data.commands, '',
    '## Rules', '', data.rules, '',
  ].join('\n');
}

async function generateCopilotInstructionsWithClaude(
  targetPath: string,
  entries: WalkEntry[],
  techStack: string[],
  frameworks: string[],
  commands: { build?: string; test?: string; dev?: string; install?: string },
): Promise<string> {
  const context = await buildCodebaseContext(targetPath, entries, techStack, frameworks, commands);
  const prompt = `You are analyzing a codebase to generate a copilot-instructions.md file for GitHub Copilot.

${context}

## Task
Generate a copilot-instructions.md with these sections. Be specific to THIS codebase.

1. **Project Overview** — What this project does, key architecture
2. **Conventions** — Coding style, naming, file organization
3. **Commands** — Build, test, run commands
4. **Architecture** — How components interact, data flow`;

  const { data } = await callClaudeStructured(
    { prompt, cwd: targetPath, timeout: 120_000 },
    CopilotInstructionsSectionsSchema,
  );

  const projectName = basename(targetPath);
  return [
    `# ${projectName} - Copilot Instructions`, '',
    '## Project Overview', '', data.projectOverview, '',
    '## Conventions', '', data.conventions, '',
    '## Commands', '', data.commands, '',
    '## Architecture', '', data.architecture, '',
  ].join('\n');
}

async function generateAgentsMdWithClaude(
  targetPath: string,
  entries: WalkEntry[],
  techStack: string[],
  frameworks: string[],
  commands: { build?: string; test?: string; dev?: string; install?: string },
): Promise<string> {
  const context = await buildCodebaseContext(targetPath, entries, techStack, frameworks, commands);
  const prompt = `You are analyzing a codebase to generate an AGENTS.md file for AI coding agents.

${context}

## Task
Generate an AGENTS.md with these sections. Be specific to THIS codebase.

1. **Overview** — What this project does, its purpose and scope
2. **Key Directories** — Purpose of each major directory
3. **Making Changes** — How to add features, fix bugs, follow patterns
4. **Testing** — How to run tests, write new tests
5. **Common Pitfalls** — Things that will trip up an AI agent`;

  const { data } = await callClaudeStructured(
    { prompt, cwd: targetPath, timeout: 120_000 },
    AgentsMdSectionsSchema,
  );

  const projectName = basename(targetPath);
  return [
    `# ${projectName} - Agent Instructions`, '',
    '## Overview', '', data.overview, '',
    '## Key Directories', '', data.keyDirectories, '',
    '## Making Changes', '', data.makingChanges, '',
    '## Testing', '', data.testing, '',
    '## Common Pitfalls', '', data.commonPitfalls, '',
  ].join('\n');
}

export async function runInit(targetPath: string, verbose: boolean, overwrite: boolean = false): Promise<void> {
  console.log('');
  console.log(chalk.bold('  llm-sense init') + ' — Scaffolding AI config files');
  console.log(chalk.dim(`  Target: ${targetPath}`));
  if (overwrite) console.log(chalk.yellow('  --overwrite: will replace existing files'));
  console.log('');

  // Run Phase 1 for context
  console.log(chalk.dim('  Analyzing codebase...'));
  const { result: staticResult, entries } = await runStaticAnalysis(targetPath, verbose);
  console.log(chalk.green('  ✓') + ` ${staticResult.fileSizes.totalFiles} files analyzed`);

  // Detect tech stack, frameworks, commands
  const techStack = detectTechStack(staticResult, targetPath);
  const frameworks = await detectFramework(targetPath);
  const commands = await detectCommands(targetPath);

  if (techStack.length > 0 || frameworks.length > 0) {
    console.log(chalk.dim(`  Detected: ${[...techStack, ...frameworks].join(', ')}`));
  }

  // Check if Claude CLI is available for AI-powered generation
  const claudeAvailable = await isClaudeInstalled();
  if (claudeAvailable) {
    console.log(chalk.cyan('  Claude CLI detected — generating AI-powered config files...'));
  } else {
    console.log(chalk.yellow('  Claude CLI not found — using template-based generation (install Claude for richer output)'));
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
    console.log(chalk.green('  ✓') + ` Created ${chalk.underline(label)}`);
    filesCreated++;
  }

  // Generate content — AI-powered or template-based
  let claudeMdContent: string;
  let cursorContent: string;
  let copilotContent: string;
  let agentsContent: string;

  if (claudeAvailable) {
    try {
      claudeMdContent = await generateClaudeMdWithClaude(targetPath, entries, techStack, frameworks, commands);
    } catch (e) {
      console.log(chalk.yellow(`  CLAUDE.md AI generation failed, falling back to template: ${e instanceof Error ? e.message : e}`));
      claudeMdContent = generateClaudeMdFromStatic(staticResult, targetPath, techStack, frameworks, commands);
    }

    try {
      cursorContent = await generateCursorRulesWithClaude(targetPath, entries, techStack, frameworks, commands);
    } catch {
      cursorContent = generateCursorRules(staticResult, targetPath, techStack, frameworks, commands);
    }

    try {
      copilotContent = await generateCopilotInstructionsWithClaude(targetPath, entries, techStack, frameworks, commands);
    } catch {
      copilotContent = generateCopilotInstructions(staticResult, targetPath, techStack, frameworks, commands);
    }

    try {
      agentsContent = await generateAgentsMdWithClaude(targetPath, entries, techStack, frameworks, commands);
    } catch {
      agentsContent = generateAgentsMd(staticResult, targetPath, techStack, frameworks);
    }
  } else {
    claudeMdContent = generateClaudeMdFromStatic(staticResult, targetPath, techStack, frameworks, commands);
    cursorContent = generateCursorRules(staticResult, targetPath, techStack, frameworks, commands);
    copilotContent = generateCopilotInstructions(staticResult, targetPath, techStack, frameworks, commands);
    agentsContent = generateAgentsMd(staticResult, targetPath, techStack, frameworks);
  }

  // CLAUDE.md — always generate
  await writeConfig(join(targetPath, 'CLAUDE.md'), 'CLAUDE.md', claudeMdContent);

  // .cursorrules — always generate
  await writeConfig(join(targetPath, '.cursorrules'), '.cursorrules', cursorContent);

  // .github/copilot-instructions.md — generate if .github/ exists or create it
  if (await fileExists(join(targetPath, '.github')) || await fileExists(join(targetPath, '.git'))) {
    await writeConfig(
      join(targetPath, '.github', 'copilot-instructions.md'),
      '.github/copilot-instructions.md',
      copilotContent,
    );
  }

  // AGENTS.md — always generate
  await writeConfig(join(targetPath, 'AGENTS.md'), 'AGENTS.md', agentsContent);

  console.log('');
  if (filesCreated > 0) {
    const reviewMsg = claudeAvailable ? ' Review the generated content for accuracy.' : ' Review and fill in the TODO sections.';
    console.log(chalk.bold(`  ${filesCreated} file${filesCreated > 1 ? 's' : ''} created.`) + reviewMsg);
  } else {
    console.log(chalk.dim('  All config files already exist. Use --overwrite to replace them.'));
  }
  console.log(chalk.dim('  Run `llm-sense --skip-empirical` to see your updated score.'));
  console.log('');
}
