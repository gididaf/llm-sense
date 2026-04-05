import { access, writeFile, readFile, mkdir } from 'node:fs/promises';
import { join, basename, dirname } from 'node:path';
import chalk from 'chalk';
import { runStaticAnalysis } from '../phases/staticAnalysis.js';
import { isClaudeInstalled, callClaudeStructured } from '../core/claude.js';
import { buildDirectorySummary, stratifiedSample, readFileSafe, getSourceFiles } from '../core/fs.js';
import type { WalkEntry } from '../core/fs.js';
import { ClaudeMdSectionsSchema, CursorRulesSectionsSchema, CopilotInstructionsSectionsSchema, AgentsMdSectionsSchema } from '../types.js';
import type { StaticAnalysisResult } from '../types.js';
import {
  getAllFormats, getFormatsByIds, listFormats, detectExistingFormats, detectMissingFormats,
  type ConfigFormat, type ConfigContext,
} from '../configs/registry.js';
import type { LlmProvider } from '../core/providers.js';

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// Detect tech stack from file extensions + dependency files
function detectTechStack(staticResult: StaticAnalysisResult, _targetPath: string): string[] {
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
      content: await readFileSafe(f.path, 10_000),
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

// AI generation functions for the 4 main formats (kept from original)

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

// Map format IDs to AI generators (only the 4 main formats have deep AI generation)
// Legacy: Claude-specific generators (used when provider is ClaudeProvider)
const AI_GENERATORS: Record<string, (
  targetPath: string,
  entries: WalkEntry[],
  techStack: string[],
  frameworks: string[],
  commands: { build?: string; test?: string; dev?: string; install?: string },
) => Promise<string>> = {
  claude: generateClaudeMdWithClaude,
  cursor: generateCursorRulesWithClaude,
  copilot: generateCopilotInstructionsWithClaude,
  agents: generateAgentsMdWithClaude,
};

// Provider-agnostic generators — work with any LlmProvider
async function generateWithProvider(
  formatId: string,
  provider: LlmProvider,
  targetPath: string,
  entries: WalkEntry[],
  techStack: string[],
  frameworks: string[],
  commands: { build?: string; test?: string; dev?: string; install?: string },
): Promise<string | null> {
  const context = await buildCodebaseContext(targetPath, entries, techStack, frameworks, commands);
  const projectName = basename(targetPath);

  switch (formatId) {
    case 'claude': {
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

      const { data } = await provider.generateStructured(prompt, ClaudeMdSectionsSchema, { cwd: targetPath });
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
    case 'cursor': {
      const prompt = `You are analyzing a codebase to generate a .cursorrules file for Cursor AI.

${context}

## Task
Generate a .cursorrules file with these sections. Be specific to THIS codebase, not generic.

1. **Project Context** — What this project does, key technologies
2. **Coding Conventions** — Naming, file structure, patterns used
3. **Important Files** — Key entry points, configs, and critical files
4. **Commands** — Build, test, run, deploy commands
5. **Rules** — Specific rules for working with this codebase`;

      const { data } = await provider.generateStructured(prompt, CursorRulesSectionsSchema, { cwd: targetPath });
      return [
        `# ${projectName} - Cursor Rules`, '',
        '## Project Context', '', data.projectContext, '',
        '## Coding Conventions', '', data.codingConventions, '',
        '## Important Files', '', data.importantFiles, '',
        '## Commands', '', data.commands, '',
        '## Rules', '', data.rules, '',
      ].join('\n');
    }
    case 'copilot': {
      const prompt = `You are analyzing a codebase to generate a copilot-instructions.md file for GitHub Copilot.

${context}

## Task
Generate a copilot-instructions.md with these sections. Be specific to THIS codebase.

1. **Project Overview** — What this project does, key architecture
2. **Conventions** — Coding style, naming, file organization
3. **Commands** — Build, test, run commands
4. **Architecture** — How components interact, data flow`;

      const { data } = await provider.generateStructured(prompt, CopilotInstructionsSectionsSchema, { cwd: targetPath });
      return [
        `# ${projectName} - Copilot Instructions`, '',
        '## Project Overview', '', data.projectOverview, '',
        '## Conventions', '', data.conventions, '',
        '## Commands', '', data.commands, '',
        '## Architecture', '', data.architecture, '',
      ].join('\n');
    }
    case 'agents': {
      const prompt = `You are analyzing a codebase to generate an AGENTS.md file for AI coding agents.

${context}

## Task
Generate an AGENTS.md with these sections. Be specific to THIS codebase.

1. **Overview** — What this project does, its purpose and scope
2. **Key Directories** — Purpose of each major directory
3. **Making Changes** — How to add features, fix bugs, follow patterns
4. **Testing** — How to run tests, write new tests
5. **Common Pitfalls** — Things that will trip up an AI agent`;

      const { data } = await provider.generateStructured(prompt, AgentsMdSectionsSchema, { cwd: targetPath });
      return [
        `# ${projectName} - Agent Instructions`, '',
        '## Overview', '', data.overview, '',
        '## Key Directories', '', data.keyDirectories, '',
        '## Making Changes', '', data.makingChanges, '',
        '## Testing', '', data.testing, '',
        '## Common Pitfalls', '', data.commonPitfalls, '',
      ].join('\n');
    }
    default:
      return null;
  }
}

const AI_GENERATOR_FORMAT_IDS = new Set(['claude', 'cursor', 'copilot', 'agents']);

// ─── Main Init Command ────────────────────────────────────

export interface InitOptions {
  verbose: boolean;
  overwrite: boolean;
  tools?: string[];   // --tools cursor,claude,windsurf
  list: boolean;      // --list
  detect: boolean;    // --detect
  provider?: string;  // --provider openai|google|claude
}

export async function runInit(targetPath: string, verbose: boolean, overwrite: boolean = false, initOptions?: Partial<InitOptions>): Promise<void> {
  const opts: InitOptions = {
    verbose,
    overwrite,
    list: false,
    detect: false,
    ...initOptions,
  };

  // --list: show all supported formats and exit
  if (opts.list) {
    const formats = listFormats();
    console.log('');
    console.log(chalk.bold('  Supported AI Tool Config Formats') + chalk.dim(` (${formats.length} tools)`));
    console.log('');
    console.log(chalk.dim('  ID                File Path                         Tool                    Tier  Stable'));
    console.log(chalk.dim('  ' + '─'.repeat(90)));
    for (const f of formats) {
      const stableStr = f.stable ? chalk.green('yes') : chalk.yellow('no ');
      console.log(`  ${f.id.padEnd(18)} ${f.filePath.padEnd(34)} ${f.name.padEnd(24)} T${f.tier}    ${stableStr}`);
    }
    console.log('');
    console.log(chalk.dim(`  Use: llm-sense init --tools ${formats.slice(0, 3).map(f => f.id).join(',')}`));
    console.log('');
    return;
  }

  console.log('');
  console.log(chalk.bold('  llm-sense init') + ' — Scaffolding AI config files');
  console.log(chalk.dim(`  Target: ${targetPath}`));
  if (overwrite) console.log(chalk.yellow('  --overwrite: will replace existing files'));
  console.log('');

  // --detect: show existing configs and generate missing ones
  if (opts.detect) {
    const existing = await detectExistingFormats(targetPath);
    const missing = await detectMissingFormats(targetPath);

    console.log(chalk.green(`  Found ${existing.length} existing config(s):`));
    for (const f of existing) {
      console.log(chalk.dim(`    ✓ ${f.filePath} (${f.name})`));
    }
    console.log('');
    console.log(chalk.yellow(`  Missing ${missing.length} config(s):`));
    for (const f of missing) {
      console.log(chalk.dim(`    ✗ ${f.filePath} (${f.name})`));
    }
    console.log('');

    if (missing.length === 0) {
      console.log(chalk.green('  All AI tool configs are present!'));
      console.log('');
      return;
    }

    // Generate missing configs
    console.log(chalk.cyan(`  Generating ${missing.length} missing config files...`));
    console.log('');
  }

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

  // Build shared context for template generation
  const ctx: ConfigContext = {
    projectName: basename(targetPath),
    techStack,
    frameworks,
    commands,
    staticResult,
    targetPath,
  };

  // Resolve LLM provider: specified → Claude CLI → null (template fallback)
  const { resolveProvider } = await import('../core/providers.js');
  const provider = await resolveProvider(opts.provider);
  if (provider) {
    console.log(chalk.cyan(`  LLM provider: ${provider.name} — AI-powered generation for main formats`));
  } else {
    console.log(chalk.yellow('  No LLM provider available — using template-based generation'));
  }
  console.log('');

  // Determine which formats to generate
  let formats: ConfigFormat[];
  if (opts.tools && opts.tools.length > 0) {
    formats = getFormatsByIds(opts.tools);
    if (formats.length === 0) {
      console.error(chalk.red(`  No matching formats for: ${opts.tools.join(', ')}`));
      console.error(chalk.dim('  Run `llm-sense init --list` to see available formats.'));
      return;
    }
    if (formats.length < opts.tools.length) {
      const found = new Set(formats.map(f => f.id));
      const unknown = opts.tools.filter(t => !found.has(t.toLowerCase()));
      console.log(chalk.yellow(`  Unknown tool IDs skipped: ${unknown.join(', ')}`));
    }
  } else if (opts.detect) {
    formats = await detectMissingFormats(targetPath);
  } else {
    // Default: generate all formats
    formats = getAllFormats();
  }

  console.log(chalk.dim(`  Generating ${formats.length} config file(s)...`));
  console.log('');

  let filesCreated = 0;
  let filesSkipped = 0;

  for (const format of formats) {
    const filePath = join(targetPath, format.filePath);

    // Check if file already exists
    if (await fileExists(filePath) && !overwrite) {
      filesSkipped++;
      if (verbose) {
        console.log(chalk.dim(`  ${format.filePath} already exists — skipping`));
      }
      continue;
    }

    // Generate content — AI for main formats (via provider), template for the rest
    let content: string;
    if (provider && AI_GENERATOR_FORMAT_IDS.has(format.id)) {
      try {
        const generated = await generateWithProvider(format.id, provider, targetPath, entries, techStack, frameworks, commands);
        content = generated ?? format.templateFn(ctx);
      } catch (e) {
        if (verbose) {
          console.log(chalk.yellow(`  AI generation failed for ${format.filePath}, using template: ${e instanceof Error ? e.message : e}`));
        }
        content = format.templateFn(ctx);
      }
    } else {
      content = format.templateFn(ctx);
    }

    // Ensure parent directory exists
    const dir = dirname(filePath);
    if (dir !== targetPath) {
      await mkdir(dir, { recursive: true });
    }

    await writeFile(filePath, content, 'utf-8');
    const unstableNote = !format.stable ? chalk.dim(' (unstable format)') : '';
    console.log(chalk.green('  ✓') + ` Created ${chalk.underline(format.filePath)} — ${format.name}${unstableNote}`);
    filesCreated++;
  }

  console.log('');
  if (filesCreated > 0) {
    const reviewMsg = provider ? ' Review the generated content for accuracy.' : ' Review and fill in the TODO sections.';
    console.log(chalk.bold(`  ${filesCreated} file${filesCreated > 1 ? 's' : ''} created.`) + reviewMsg);
  }
  if (filesSkipped > 0) {
    console.log(chalk.dim(`  ${filesSkipped} file${filesSkipped > 1 ? 's' : ''} already exist. Use --overwrite to replace.`));
  }
  if (filesCreated === 0 && filesSkipped > 0) {
    console.log(chalk.dim('  All config files already exist. Use --overwrite to replace them.'));
  }

  // Promote AGENTS.md — Linux Foundation universal standard
  const agentsFormat = formats.find(f => f.id === 'agents');
  const agentsPath = join(targetPath, 'AGENTS.md');
  if (agentsFormat && filesCreated > 0) {
    const agentsExists = await fileExists(agentsPath);
    if (agentsExists) {
      console.log(chalk.cyan('  Tip:') + ` AGENTS.md is the Linux Foundation universal standard for AI agents (60K+ repos).`);
      console.log(chalk.dim('        It works across all major AI coding tools.'));
    }
  } else if (!agentsFormat && !(await fileExists(agentsPath))) {
    console.log(chalk.cyan('  Tip:') + ` Consider adding AGENTS.md — the Linux Foundation universal AI agent standard.`);
    console.log(chalk.dim('        Run: llm-sense init --tools agents'));
  }

  console.log(chalk.dim('  Run `llm-sense --skip-empirical` to see your updated score.'));
  console.log('');
}
