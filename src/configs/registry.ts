import { access } from 'node:fs/promises';
import { join } from 'node:path';
import type { StaticAnalysisResult } from '../types.js';

// ─── Config Context (shared across all format generators) ─────

export interface ConfigContext {
  projectName: string;
  techStack: string[];
  frameworks: string[];
  commands: { build?: string; test?: string; dev?: string; install?: string };
  staticResult: StaticAnalysisResult;
  targetPath: string;
}

// ─── Config Format Definition ─────────────────────────────────

export interface ConfigFormat {
  id: string;
  name: string;
  filePath: string;
  category: 'markdown' | 'yaml' | 'json' | 'custom';
  tier: 1 | 2 | 3;
  stable: boolean;
  templateFn: (ctx: ConfigContext) => string;
  detectExisting: (rootDir: string) => Promise<boolean>;
}

// ─── Helper: file existence check ─────────────────────────────

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// ─── Shared template helpers ──────────────────────────────────

function stackLine(ctx: ConfigContext): string {
  const all = [...ctx.techStack, ...ctx.frameworks];
  return all.length > 0 ? all.join(', ') : 'unknown';
}

function commandsBlock(ctx: ConfigContext): string {
  const lines: string[] = [];
  if (ctx.commands.install) lines.push(ctx.commands.install);
  if (ctx.commands.build) lines.push(ctx.commands.build);
  if (ctx.commands.test) lines.push(ctx.commands.test);
  if (ctx.commands.dev) lines.push(ctx.commands.dev);
  return lines.length > 0 ? lines.join('\n') : '# No commands detected';
}

function commandsList(ctx: ConfigContext): string {
  const lines: string[] = [];
  if (ctx.commands.build) lines.push(`- Build: \`${ctx.commands.build}\``);
  if (ctx.commands.test) lines.push(`- Test: \`${ctx.commands.test}\``);
  if (ctx.commands.dev) lines.push(`- Dev: \`${ctx.commands.dev}\``);
  if (ctx.commands.install) lines.push(`- Install: \`${ctx.commands.install}\``);
  return lines.length > 0 ? lines.join('\n') : '- No commands detected';
}

function rulesBlock(ctx: ConfigContext): string {
  return `- Follow the existing ${ctx.staticResult.naming.dominantConvention} naming convention
- Keep files under 300 lines when possible
- Add inline comments for non-obvious logic
- Read existing patterns before creating new files`;
}

// ─── Markdown template (used by most tools) ───────────────────

function markdownTemplate(ctx: ConfigContext, toolName: string, extras?: string): string {
  return `# ${ctx.projectName} — ${toolName} Configuration

## Project Overview
${ctx.projectName} is built with ${stackLine(ctx)}.
${ctx.staticResult.fileSizes.totalFiles} source files, ${ctx.staticResult.fileSizes.totalLines.toLocaleString()} total lines.

## Conventions
- File naming: ${ctx.staticResult.naming.dominantConvention}
- Directory depth: ${ctx.staticResult.directoryStructure.maxDepth} levels, avg ${ctx.staticResult.directoryStructure.avgFilesPerDir} files/dir
${rulesBlock(ctx)}

## Commands
${commandsList(ctx)}

## Architecture
<!-- Describe the project architecture and data flow -->

## Important Notes
<!-- Add project-specific gotchas and pitfalls -->
${extras ? '\n' + extras : ''}
`;
}

// ─── Format Definitions ───────────────────────────────────────

const CONFIG_REGISTRY: ConfigFormat[] = [
  // ─── Tier 1: Major tools (previously supported) ────────
  {
    id: 'claude',
    name: 'Claude Code',
    filePath: 'CLAUDE.md',
    category: 'markdown',
    tier: 1,
    stable: true,
    detectExisting: (root) => exists(join(root, 'CLAUDE.md')),
    templateFn: (ctx) => {
      const lines: string[] = [];
      lines.push(`# ${ctx.projectName}`);
      lines.push('');
      lines.push('## Architecture Overview');
      lines.push('');
      lines.push('<!-- TODO: Describe the high-level architecture and data flow -->');
      lines.push('');
      if (ctx.techStack.length > 0 || ctx.frameworks.length > 0) {
        lines.push('## Tech Stack');
        lines.push('');
        for (const tech of ctx.techStack) lines.push(`- **${tech}**`);
        for (const fw of ctx.frameworks) lines.push(`- **${fw}**`);
        lines.push('');
      }
      lines.push('## Module Map');
      lines.push('');
      lines.push('```');
      lines.push(`${ctx.projectName}/`);
      lines.push('├── ... (fill in key directories and their purposes)');
      lines.push('```');
      lines.push('');
      lines.push('## Common Patterns');
      lines.push('');
      lines.push('<!-- TODO: Add "how to add a new X" examples for common operations -->');
      lines.push('');
      lines.push('## Testing');
      lines.push('');
      if (ctx.commands.test) {
        lines.push('```bash');
        lines.push(ctx.commands.test);
        lines.push('```');
      } else {
        lines.push('<!-- TODO: Add testing approach and commands -->');
      }
      lines.push('');
      lines.push('## Build / Run / Deploy');
      lines.push('');
      lines.push('```bash');
      lines.push(commandsBlock(ctx));
      lines.push('```');
      lines.push('');
      lines.push('## Gotchas');
      lines.push('');
      lines.push('<!-- TODO: Add pitfalls, caveats, and things to watch out for -->');
      lines.push('');
      lines.push('## Environment Setup');
      lines.push('');
      lines.push('```bash');
      if (ctx.commands.install) {
        lines.push(ctx.commands.install);
      } else {
        lines.push('# TODO: Add environment setup instructions');
      }
      lines.push('```');
      lines.push('');
      return lines.join('\n');
    },
  },

  {
    id: 'cursor',
    name: 'Cursor',
    filePath: '.cursorrules',
    category: 'markdown',
    tier: 1,
    stable: true,
    detectExisting: (root) => exists(join(root, '.cursorrules')),
    templateFn: (ctx) => {
      const lines: string[] = [];
      lines.push(`# ${ctx.projectName} - Cursor Rules`);
      lines.push('');
      lines.push('## Project Context');
      lines.push(`This is the ${ctx.projectName} project built with ${stackLine(ctx)}.`);
      lines.push('');
      lines.push('## Coding Conventions');
      lines.push(`- Naming: ${ctx.staticResult.naming.dominantConvention}`);
      lines.push(`- File structure: ${ctx.staticResult.directoryStructure.maxDepth} levels deep, avg ${ctx.staticResult.directoryStructure.avgFilesPerDir} files/dir`);
      lines.push('');
      lines.push('## Important Files');
      lines.push('<!-- TODO: List key entry points and configuration files -->');
      lines.push('');
      if (ctx.commands.build || ctx.commands.test) {
        lines.push('## Commands');
        lines.push(commandsList(ctx));
        lines.push('');
      }
      lines.push('## Rules');
      lines.push(rulesBlock(ctx));
      lines.push('');
      return lines.join('\n');
    },
  },

  {
    id: 'copilot',
    name: 'GitHub Copilot',
    filePath: '.github/copilot-instructions.md',
    category: 'markdown',
    tier: 1,
    stable: true,
    detectExisting: (root) => exists(join(root, '.github', 'copilot-instructions.md')),
    templateFn: (ctx) => {
      const lines: string[] = [];
      lines.push(`# ${ctx.projectName} - Copilot Instructions`);
      lines.push('');
      lines.push('## Project Overview');
      lines.push(`This is the ${ctx.projectName} project built with ${stackLine(ctx)}.`);
      lines.push('');
      lines.push('## Conventions');
      lines.push(`- File naming: ${ctx.staticResult.naming.dominantConvention}`);
      lines.push('- Keep functions focused and files small');
      lines.push('');
      if (ctx.commands.build || ctx.commands.test) {
        lines.push('## Commands');
        lines.push(commandsList(ctx));
        lines.push('');
      }
      lines.push('## Architecture');
      lines.push('<!-- TODO: Describe the project architecture -->');
      lines.push('');
      return lines.join('\n');
    },
  },

  {
    id: 'agents',
    name: 'OpenAI Codex / Agents',
    filePath: 'AGENTS.md',
    category: 'markdown',
    tier: 1,
    stable: true,
    detectExisting: (root) => exists(join(root, 'AGENTS.md')),
    templateFn: (ctx) => {
      const lines: string[] = [];
      lines.push(`# ${ctx.projectName} - Agent Instructions`);
      lines.push('');
      lines.push('## Overview');
      lines.push(`${ctx.projectName} is a ${stackLine(ctx)} project with ${ctx.staticResult.fileSizes.totalFiles} source files.`);
      lines.push('');
      lines.push('## Working with this Codebase');
      lines.push('');
      lines.push('### Key Directories');
      lines.push('<!-- TODO: Describe the purpose of each top-level directory -->');
      lines.push('');
      lines.push('### Making Changes');
      lines.push('- Read existing patterns before creating new files');
      lines.push(`- Follow the dominant naming convention: ${ctx.staticResult.naming.dominantConvention}`);
      lines.push('- Keep modules focused and files under 300 lines');
      lines.push('');
      lines.push('### Testing');
      if (ctx.staticResult.devInfra.hasTestCommand) {
        lines.push('- Always run tests after making changes');
        if (ctx.commands.test) lines.push(`- Test command: \`${ctx.commands.test}\``);
      } else {
        lines.push('- <!-- TODO: Add testing instructions -->');
      }
      lines.push('');
      lines.push('### Common Pitfalls');
      lines.push('<!-- TODO: Add module-specific pitfalls and gotchas -->');
      lines.push('');
      return lines.join('\n');
    },
  },

  // ─── Tier 2: High-priority additions ───────────────────

  {
    id: 'windsurf',
    name: 'Windsurf (Codeium)',
    filePath: '.windsurfrules',
    category: 'markdown',
    tier: 2,
    stable: true,
    detectExisting: (root) => exists(join(root, '.windsurfrules')),
    templateFn: (ctx) => markdownTemplate(ctx, 'Windsurf'),
  },

  {
    id: 'cline',
    name: 'Cline',
    filePath: '.clinerules',
    category: 'markdown',
    tier: 2,
    stable: true,
    detectExisting: (root) => exists(join(root, '.clinerules')),
    templateFn: (ctx) => markdownTemplate(ctx, 'Cline'),
  },

  {
    id: 'devin',
    name: 'Devin (Cognition)',
    filePath: 'devin.md',
    category: 'markdown',
    tier: 2,
    stable: true,
    detectExisting: (root) => exists(join(root, 'devin.md')),
    templateFn: (ctx) => markdownTemplate(ctx, 'Devin'),
  },

  {
    id: 'amazonq',
    name: 'Amazon Q Developer',
    filePath: '.amazonq/rules',
    category: 'custom',
    tier: 2,
    stable: true,
    detectExisting: (root) => exists(join(root, '.amazonq', 'rules')),
    templateFn: (ctx) => markdownTemplate(ctx, 'Amazon Q Developer'),
  },

  {
    id: 'gemini',
    name: 'Google Gemini CLI',
    filePath: 'GEMINI.md',
    category: 'markdown',
    tier: 2,
    stable: true,
    detectExisting: (root) => exists(join(root, 'GEMINI.md')),
    templateFn: (ctx) => markdownTemplate(ctx, 'Gemini CLI'),
  },

  {
    id: 'aider',
    name: 'Aider',
    filePath: '.aider.conf.yml',
    category: 'yaml',
    tier: 2,
    stable: true,
    detectExisting: (root) => exists(join(root, '.aider.conf.yml')),
    templateFn: (ctx) => {
      return `# Aider configuration for ${ctx.projectName}
# See https://aider.chat/docs/config/ayfull.html

# Project conventions
# lint-cmd: ${ctx.commands.test ? ctx.commands.test : '# add linter command'}
# test-cmd: ${ctx.commands.test ?? '# add test command'}

# Auto-commit settings
auto-commits: true
dirty-commits: false

# Context
# read:
#   - CLAUDE.md
#   - README.md
`;
    },
  },

  {
    id: 'zed',
    name: 'Zed Editor',
    filePath: '.zed/rules',
    category: 'custom',
    tier: 2,
    stable: false,
    detectExisting: (root) => exists(join(root, '.zed', 'rules')),
    templateFn: (ctx) => markdownTemplate(ctx, 'Zed AI'),
  },

  {
    id: 'continue',
    name: 'Continue',
    filePath: '.continuerc.json',
    category: 'json',
    tier: 2,
    stable: true,
    detectExisting: (root) => exists(join(root, '.continuerc.json')),
    templateFn: (ctx) => {
      const config = {
        docs: [{ title: 'Project Docs', startUrl: 'README.md' }],
        systemMessage: `You are working on ${ctx.projectName}, built with ${stackLine(ctx)}. Follow the ${ctx.staticResult.naming.dominantConvention} naming convention. Keep files under 300 lines.`,
      };
      return JSON.stringify(config, null, 2) + '\n';
    },
  },

  {
    id: 'augment',
    name: 'Augment Code',
    filePath: 'augment-guidelines.md',
    category: 'markdown',
    tier: 2,
    stable: true,
    detectExisting: (root) => exists(join(root, 'augment-guidelines.md')),
    templateFn: (ctx) => markdownTemplate(ctx, 'Augment Code'),
  },

  {
    id: 'roo',
    name: 'Roo Code',
    filePath: '.roorules',
    category: 'markdown',
    tier: 2,
    stable: false,
    detectExisting: async (root) => (await exists(join(root, '.roorules'))) || (await exists(join(root, '.roo', 'rules'))),
    templateFn: (ctx) => markdownTemplate(ctx, 'Roo Code'),
  },

  // ─── Tier 3: Broad coverage ────────────────────────────

  {
    id: 'bolt',
    name: 'Bolt (StackBlitz)',
    filePath: 'bolt.instructions.md',
    category: 'markdown',
    tier: 3,
    stable: false,
    detectExisting: (root) => exists(join(root, 'bolt.instructions.md')),
    templateFn: (ctx) => markdownTemplate(ctx, 'Bolt'),
  },

  {
    id: 'replit',
    name: 'Replit AI',
    filePath: '.replit/ai-rules',
    category: 'custom',
    tier: 3,
    stable: false,
    detectExisting: (root) => exists(join(root, '.replit', 'ai-rules')),
    templateFn: (ctx) => markdownTemplate(ctx, 'Replit AI'),
  },

  {
    id: 'tabnine',
    name: 'Tabnine',
    filePath: '.tabnine/config.json',
    category: 'json',
    tier: 3,
    stable: true,
    detectExisting: (root) => exists(join(root, '.tabnine', 'config.json')),
    templateFn: (ctx) => {
      const config = {
        projectContext: `${ctx.projectName} — ${stackLine(ctx)}`,
        conventions: {
          naming: ctx.staticResult.naming.dominantConvention,
          maxFileLines: 300,
        },
      };
      return JSON.stringify(config, null, 2) + '\n';
    },
  },

  {
    id: 'guidelines',
    name: 'Generic AI Guidelines',
    filePath: 'guidelines.md',
    category: 'markdown',
    tier: 3,
    stable: true,
    detectExisting: (root) => exists(join(root, 'guidelines.md')),
    templateFn: (ctx) => markdownTemplate(ctx, 'AI Assistant'),
  },

  {
    id: 'sourcery',
    name: 'Sourcery',
    filePath: '.sourcery.yaml',
    category: 'yaml',
    tier: 3,
    stable: true,
    detectExisting: (root) => exists(join(root, '.sourcery.yaml')),
    templateFn: (ctx) => {
      return `# Sourcery configuration for ${ctx.projectName}
# See https://docs.sourcery.ai/Configuration/

refactor:
  skip: []

rules: []

metrics:
  quality_threshold: 25.0

github:
  labels: []

clone_detection:
  min_lines: 3
  min_duplicates: 2
`;
    },
  },

  {
    id: 'kiro',
    name: 'Kiro (AWS)',
    filePath: '.kiro/rules',
    category: 'custom',
    tier: 3,
    stable: false,
    detectExisting: async (root) => (await exists(join(root, '.kiro', 'rules'))) || (await exists(join(root, 'kiro.md'))),
    templateFn: (ctx) => markdownTemplate(ctx, 'Kiro'),
  },

  {
    id: 'cody',
    name: 'Sourcegraph Cody',
    filePath: '.cody/config.json',
    category: 'json',
    tier: 3,
    stable: true,
    detectExisting: (root) => exists(join(root, '.cody', 'config.json')),
    templateFn: (ctx) => {
      const config = {
        $schema: 'https://sourcegraph.com/.api/cody/config-schema.json',
        context: {
          include: ['**/*.ts', '**/*.js', '**/*.py', '**/*.go', '**/*.rs', '**/*.java'],
        },
        instructions: `This is ${ctx.projectName}, built with ${stackLine(ctx)}. Naming: ${ctx.staticResult.naming.dominantConvention}.`,
      };
      return JSON.stringify(config, null, 2) + '\n';
    },
  },

  {
    id: 'double',
    name: 'Double',
    filePath: '.double/rules',
    category: 'custom',
    tier: 3,
    stable: false,
    detectExisting: (root) => exists(join(root, '.double', 'rules')),
    templateFn: (ctx) => markdownTemplate(ctx, 'Double'),
  },

  {
    id: 'marscode',
    name: 'MarsCode (ByteDance)',
    filePath: '.marscode/rules',
    category: 'custom',
    tier: 3,
    stable: false,
    detectExisting: (root) => exists(join(root, '.marscode', 'rules')),
    templateFn: (ctx) => markdownTemplate(ctx, 'MarsCode'),
  },

  {
    id: 'trae',
    name: 'Trae (ByteDance)',
    filePath: '.trae/rules',
    category: 'custom',
    tier: 3,
    stable: false,
    detectExisting: (root) => exists(join(root, '.trae', 'rules')),
    templateFn: (ctx) => markdownTemplate(ctx, 'Trae'),
  },

  {
    id: 'mentat',
    name: 'Mentat',
    filePath: 'MENTAT.md',
    category: 'markdown',
    tier: 3,
    stable: false,
    detectExisting: (root) => exists(join(root, 'MENTAT.md')),
    templateFn: (ctx) => markdownTemplate(ctx, 'Mentat'),
  },

  {
    id: 'aide',
    name: 'Aide',
    filePath: '.aide/rules',
    category: 'custom',
    tier: 3,
    stable: false,
    detectExisting: (root) => exists(join(root, '.aide', 'rules')),
    templateFn: (ctx) => markdownTemplate(ctx, 'Aide'),
  },

  {
    id: 'goose',
    name: 'Goose (Block)',
    filePath: '.goose/config.yaml',
    category: 'yaml',
    tier: 3,
    stable: false,
    detectExisting: (root) => exists(join(root, '.goose', 'config.yaml')),
    templateFn: (ctx) => {
      return `# Goose configuration for ${ctx.projectName}
# See https://github.com/block/goose

profile: default
provider: openai

extensions: {}

instructions: |
  Working on ${ctx.projectName}, built with ${stackLine(ctx)}.
  Naming convention: ${ctx.staticResult.naming.dominantConvention}.
  ${ctx.commands.test ? `Run tests with: ${ctx.commands.test}` : ''}
  ${ctx.commands.build ? `Build with: ${ctx.commands.build}` : ''}
`;
    },
  },

  {
    id: 'privy',
    name: 'Privy',
    filePath: '.privy/rules',
    category: 'custom',
    tier: 3,
    stable: false,
    detectExisting: (root) => exists(join(root, '.privy', 'rules')),
    templateFn: (ctx) => markdownTemplate(ctx, 'Privy'),
  },

  {
    id: 'sweep',
    name: 'Sweep AI',
    filePath: 'sweep.yaml',
    category: 'yaml',
    tier: 3,
    stable: false,
    detectExisting: (root) => exists(join(root, 'sweep.yaml')),
    templateFn: (ctx) => {
      return `# Sweep AI configuration for ${ctx.projectName}

repo: ${ctx.projectName}

description: "${ctx.projectName} — ${stackLine(ctx)}"

branch: main

blocked_dirs:
  - node_modules
  - dist
  - build
  - .git

rules:
  - "Follow ${ctx.staticResult.naming.dominantConvention} naming convention"
  - "Keep files under 300 lines"
  - "${ctx.commands.test ? `Run tests: ${ctx.commands.test}` : 'Add tests for new features'}"
`;
    },
  },

  {
    id: 'superinterface',
    name: 'Superinterface',
    filePath: '.superinterface/rules',
    category: 'custom',
    tier: 3,
    stable: false,
    detectExisting: (root) => exists(join(root, '.superinterface', 'rules')),
    templateFn: (ctx) => markdownTemplate(ctx, 'Superinterface'),
  },

  {
    id: 'codex',
    name: 'OpenAI Codex CLI',
    filePath: '.codex/config',
    category: 'custom',
    tier: 3,
    stable: false,
    detectExisting: (root) => exists(join(root, '.codex', 'config')),
    templateFn: (ctx) => markdownTemplate(ctx, 'Codex CLI'),
  },
];

// ─── Registry API ─────────────────────────────────────────────

export function getAllFormats(): ConfigFormat[] {
  return CONFIG_REGISTRY;
}

export function getFormatsByIds(ids: string[]): ConfigFormat[] {
  const idSet = new Set(ids.map(id => id.toLowerCase()));
  return CONFIG_REGISTRY.filter(f => idSet.has(f.id));
}

export function getFormatById(id: string): ConfigFormat | undefined {
  return CONFIG_REGISTRY.find(f => f.id === id.toLowerCase());
}

export function listFormats(): Array<{ id: string; name: string; filePath: string; tier: number; stable: boolean }> {
  return CONFIG_REGISTRY.map(f => ({
    id: f.id,
    name: f.name,
    filePath: f.filePath,
    tier: f.tier,
    stable: f.stable,
  }));
}

export async function detectExistingFormats(rootDir: string): Promise<ConfigFormat[]> {
  const results: ConfigFormat[] = [];
  for (const format of CONFIG_REGISTRY) {
    if (await format.detectExisting(rootDir)) {
      results.push(format);
    }
  }
  return results;
}

export async function detectMissingFormats(rootDir: string): Promise<ConfigFormat[]> {
  const results: ConfigFormat[] = [];
  for (const format of CONFIG_REGISTRY) {
    if (!(await format.detectExisting(rootDir))) {
      results.push(format);
    }
  }
  return results;
}
