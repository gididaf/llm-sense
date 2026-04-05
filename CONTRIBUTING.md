# Contributing to llm-sense

Thanks for your interest in contributing! This guide covers how to get started.

## Prerequisites

- Node.js 18+
- npm
- Claude Code CLI (for Phases 2-4 and auto-fix)

## Setup

```bash
git clone https://github.com/gididaf/llm-sense.git
cd llm-sense
npm install
npm run build
```

## Development Workflow

1. Create a branch from `main`
2. Make your changes in `src/`
3. Run `npm run build` to compile
4. Test manually against a real codebase:
   ```bash
   node dist/index.js --skip-empirical --path /path/to/repo
   ```
5. Run `npm test` to verify nothing is broken
6. Run `npm run lint` to check code style
7. Open a pull request

## Project Structure

See the Module Map in `CLAUDE.md` for a full breakdown. Key directories:

- `src/analyzers/` — Phase 1 static analyzers
- `src/phases/` — Pipeline phases (runner, scoring, etc.)
- `src/report/` — Output formatters (Markdown, JSON, HTML)
- `src/core/` — Shared utilities (Claude CLI wrapper, filesystem, git)

## Adding a New Analyzer

1. Create `src/analyzers/my-analyzer.ts`
2. Add result type to `src/types.ts`
3. Call it from `src/phases/staticAnalysis.ts`
4. Add scoring in `src/phases/scoring.ts`
5. Update weights in `src/constants.ts`

## Code Style

- TypeScript with strict mode
- ESM imports
- Use Biome for formatting and linting (`npm run lint:fix`)

## Commit Messages

Use concise, descriptive commit messages. Focus on **why** over **what**.

## Reporting Issues

Use the GitHub issue templates for bug reports and feature requests.
