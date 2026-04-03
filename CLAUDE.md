# llm-sense

## Architecture Overview

A 6-phase CLI pipeline that analyzes codebase LLM-friendliness:

1. **Static Analysis** — 7 analyzers scan files/dirs without LLM calls (free, ~300ms)
2. **LLM Understanding** — Claude Code CLI with `--json-schema` produces structured codebase profile
3. **Task Generation** — Claude generates synthetic bugs + features tailored to the codebase
4. **Empirical Testing** — Tasks run in parallel across isolated git worktrees, with correctness verification
5. **Scoring** — Weighted aggregation across 8 categories → 0-100 score
6. **Report Generation** — Markdown report with self-contained LLM-executable improvement tasks

Phases 2-4 require Claude Code CLI. Phase 1 + 5 + 6 work standalone (`--skip-empirical`).

## Tech Stack

- **Language:** TypeScript (ESM, strict mode)
- **Runtime:** Node.js 18+
- **Build:** tsup (single ESM bundle with shebang)
- **CLI:** commander
- **Validation:** zod + zod-to-json-schema (for Claude `--json-schema` flag)
- **Terminal output:** chalk
- **Distribution:** npm (`llm-sense`)

## Module Map

```
src/
├── index.ts                    # CLI entry (commander, parses args, delegates to runner)
├── types.ts                    # ALL types — Zod schemas + TS interfaces
├── constants.ts                # Scoring weights, file extensions, CLAUDE.md sections
├── core/
│   ├── claude.ts               # Claude CLI wrapper (spawn, JSON parse, structured output, retry)
│   ├── fs.ts                   # walkDir, countLines, readFileSafe, buildTree, stratifiedSample, buildDirectorySummary, detectVibeCoderFiles
│   ├── git.ts                  # isGitRepo, worktreeAdd/Remove, gitDiffNames
│   ├── isolation.ts            # Worktree vs tmpdir-copy strategy for empirical testing
│   └── history.ts              # Score history tracking (.llm-sense/history.json)
├── analyzers/                  # Phase 1: each exports a pure function
│   ├── fileSizes.ts            # Line count distribution, god-file detection
│   ├── directoryStructure.ts   # Depth, breadth, files per dir
│   ├── naming.ts               # Convention detection + consistency scoring
│   ├── documentation.ts        # CLAUDE.md deep content scoring (8 sections), vibe coder files
│   ├── imports.ts              # Import counts, external deps
│   ├── modularity.ts           # Files per dir, barrel exports, single-file dirs
│   └── noise.ts                # Generated files, binaries, lockfiles
├── phases/
│   ├── runner.ts               # Orchestrates all phases sequentially
│   ├── staticAnalysis.ts       # Phase 1: runs all 7 analyzers
│   ├── llmUnderstanding.ts     # Phase 2: Claude CLI → CodebaseUnderstanding
│   ├── taskGeneration.ts       # Phase 3: Claude CLI → SyntheticTask[]
│   ├── empiricalTesting.ts     # Phase 4: parallel task execution in worktrees, correctness verification
│   └── scoring.ts              # Phase 5: weighted scoring formulas
└── report/
    ├── generator.ts            # Phase 6: Markdown report formatting + rendering
    └── recommendations.ts      # Executable recommendation builder + CLAUDE.md draft generator
```

## Common Patterns

**Adding a new static analyzer:**
1. Create `src/analyzers/my-analyzer.ts` exporting a function that takes `WalkEntry[]` and returns a typed result
2. Add the result type to `src/types.ts` and include it in `StaticAnalysisResult`
3. Call it from `src/phases/staticAnalysis.ts`
4. Add a scoring function in `src/phases/scoring.ts`
5. The report generator picks up category scores automatically

**Adding a new CLI flag:**
1. Add the option to `src/index.ts` (commander)
2. Add the field to `CliOptions` in `src/types.ts`
3. Pass it through `runner.ts`

**Large codebase scaling patterns:**
- `stratifiedSample()` in `fs.ts` groups files by top-level directory and samples proportionally — use it anywhere you need a representative subset of source files
- `buildDirectorySummary()` produces a directory-level overview with file counts — preferred over flat file lists for prompts targeting large repos
- Analyzers that sample files (imports, documentation) use stratified sampling with caps that scale by repo size (e.g., 200 files for small repos, 400 for 500+ file repos)
- Token efficiency scoring uses a log-scaled baseline (`5000 + 8000 * log2(fileCount)`) so large repos aren't penalized for needing more context
- Task success requires both no errors AND file correctness >= 50% overlap with expected files

**Claude CLI invocation modes:**
- `callClaudeStructured<T>()` — uses `--json-schema` for validated output (Phases 2-3)
- `callClaude()` — full agent mode with tools (Phase 4)
- `callClaudeJSON<T>()` — prompt-based JSON with Zod validation (fallback)

## Testing

No automated test suite yet. Manual testing against real codebases:
```bash
npm run build && node dist/index.js --skip-empirical --path /path/to/repo

# Full E2E with empirical (uses --bugs 2 --features 2 for speed)
npm run build && node dist/index.js --bugs 2 --features 2 --path /path/to/repo

# Large repos — use --concurrency for parallel task execution
npm run build && node dist/index.js --bugs 2 --features 2 --concurrency 3 --path /path/to/large-repo
```

## Build / Run / Deploy

```bash
npm install          # install dependencies
npm run build        # tsup → dist/index.js
npm run dev          # tsup --watch
npm publish          # publish to npm
```

## Gotchas

- **`--bare` flag breaks auth:** Claude Code CLI's `--bare` flag skips config discovery including auth. Never use it.
- **Shell functions vs binary:** `claude` may be a shell function (e.g., in sandboxed environments). The tool resolves the actual binary path via `$SHELL -lc 'command -v claude'`.
- **walkDir skips dotfiles:** The file walker skips all dotfiles/dirs by design (to avoid `.git/`). Vibe coder files like `.claude/` are detected separately via `detectVibeCoderFiles()`.
- **Non-git repos:** Empirical testing uses rsync + git init for non-git repos. This is slower than worktrees. Concurrency is auto-capped at 2 for non-git repos to avoid disk thrashing.
- **Parallel task execution:** Tasks run concurrently (default: `cpus/2`, max 5). Each task gets its own worktree so there are no conflicts. Console output interleaves but includes `[N/M]` labels.

## Environment Setup

```bash
node -v   # must be >= 18
claude auth status   # must be logged in for Phases 2-4
```

No environment variables required. All configuration via CLI flags.
