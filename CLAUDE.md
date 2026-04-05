# llm-sense

## Architecture Overview

A 7-phase CLI pipeline that analyzes codebase LLM-friendliness:

1. **Static Analysis** — 12 analyzers scan files/dirs without LLM calls (free, ~1s) + optional tree-sitter AST analysis
2. **LLM Understanding** — Claude Code CLI with `--json-schema` produces structured codebase profile
3. **Task Generation** — Claude generates synthetic bugs + features tailored to the codebase
4. **Empirical Testing** — Tasks run in parallel across isolated git worktrees, with correctness verification
5. **Scoring** — Weighted aggregation across 12 categories → 0-100 score (with custom profile support)
6. **Report Generation** — Markdown/JSON/summary/HTML report with self-contained LLM-executable improvement tasks + context window profiling
7. **Auto-Fix** — Applies recommendations via Claude Code in isolated worktrees, re-scores, merges if improved
7b. **Auto-Improve** — Iterative fix loop targeting a specific score (`--auto-improve --target 85`)

Phases 2-4 require Claude Code CLI. Phase 1 + 5 + 6 work standalone (`--skip-empirical`).
Phase 7/7b requires `--fix`/`--auto-improve` flag and a git repo.

## Tech Stack

- **Language:** TypeScript (ESM, strict mode)
- **Runtime:** Node.js 18+
- **Build:** tsup (single ESM bundle with shebang)
- **CLI:** commander (with `init` subcommand)
- **Validation:** zod + zod-to-json-schema (for Claude `--json-schema` flag)
- **Terminal output:** chalk
- **AST parsing:** web-tree-sitter (WASM, grammars downloaded on first use to `~/.llm-sense/grammars/`)
- **Distribution:** npm (`llm-sense`)

## Module Map

```
src/
├── index.ts                    # CLI entry (commander, parses args, delegates to runner)
├── types.ts                    # ALL types — Zod schemas + TS interfaces
├── constants.ts                # Scoring weights, file extensions, CLAUDE.md sections
├── interactive.ts              # Interactive post-analysis menu (readline)
├── watch.ts                    # Watch mode: fs.watch + debounced re-analysis
├── core/
│   ├── claude.ts               # Claude CLI wrapper (spawn, JSON parse, structured output, retry)
│   ├── fs.ts                   # walkDir, countLines, readFileSafe, buildTree, stratifiedSample, buildDirectorySummary, buildTokenHeatmap, detectVibeCoderFiles, isDataFile, isVendoredFile
│   ├── git.ts                  # isGitRepo, worktreeAdd/Remove, gitDiffNames
│   ├── isolation.ts            # Worktree vs tmpdir-copy strategy for empirical testing + auto-fix
│   ├── history.ts              # Score history tracking (.llm-sense/history.json)
│   ├── monorepo.ts             # Monorepo detection + package discovery
│   ├── cache.ts                # Incremental analysis cache (manifest-based mtime tracking)
│   └── ast.ts                  # Tree-sitter WASM wrapper: grammar download/caching, parser init, AST walking helpers
├── analyzers/                  # Phase 1: each exports a pure function
│   ├── fileSizes.ts            # Line count distribution, god-file detection, file classification (data/vendored/code)
│   ├── directoryStructure.ts   # Depth, breadth, files per dir
│   ├── naming.ts               # Per-directory convention detection + consistency scoring (excludes single-word names)
│   ├── documentation.ts        # CLAUDE.md deep content scoring (8 sections), config drift detection, AI config coverage/consistency, vibe coder files
│   ├── imports.ts              # Dependency graph: fan-in/out, hub files, orphan files, max chain depth
│   ├── modularity.ts           # Files per dir, barrel exports, single-file dirs
│   ├── noise.ts                # Generated files, binaries, lockfiles, vendored file detection
│   ├── astChecks.ts            # Tree-sitter AST analysis: complexity, nesting, duplicates, call graph, API surface
│   ├── devInfra.ts             # CI, test, linter, pre-commit, type checking, devcontainer, task discovery, observability
│   ├── security.ts             # Secret detection, .env exposure, sensitive files, lockfile checks
│   ├── duplicates.ts           # Semantic duplicate detection via export name fingerprinting
│   └── languageChecks.ts       # Language-specific regex checks (TS/JS, Python, Go, Rust, Java, Ruby, PHP, Swift)
├── mcp/
│   └── server.ts               # MCP server — manual stdio JSON-RPC, 9 tools for AI agent integration
├── configs/
│   └── registry.ts             # Config format registry — 31 AI tool formats with templates, detection, metadata
├── commands/
│   └── init.ts                 # `llm-sense init` — scaffold 31 AI config files via registry (--tools, --list, --detect)
├── phases/
│   ├── runner.ts               # Orchestrates all phases sequentially, format branching, exit codes
│   ├── staticAnalysis.ts       # Phase 1: runs all 11 analyzers + optional AST analysis
│   ├── llmUnderstanding.ts     # Phase 2: Claude CLI → CodebaseUnderstanding
│   ├── taskGeneration.ts       # Phase 3: Claude CLI → SyntheticTask[]
│   ├── empiricalTesting.ts     # Phase 4: parallel task execution in worktrees, correctness verification
│   ├── scoring.ts              # Phase 5: weighted scoring formulas (12 categories, architecture-aware, custom profiles)
│   └── autoFix.ts              # Phase 7: worktree isolation → Claude Code → re-score → patch merge
└── report/
    ├── generator.ts            # Phase 6: Markdown report formatting + rendering
    ├── recommendations.ts      # Executable recommendation builder + CLAUDE.md draft + effort/dependency assignment
    ├── jsonOutput.ts            # JSON formatter + summary one-liner for --format json/summary
    ├── badge.ts                # SVG badge generator for --badge flag
    ├── htmlOutput.ts            # Self-contained HTML report (radar chart, bars, heatmap) + HTML comparison view
    ├── comparison.ts           # Side-by-side repo comparison (--compare)
    └── trend.ts                # ASCII score trend chart from history (--trend)
```

## Common Patterns

**Adding a new static analyzer:**
1. Create `src/analyzers/my-analyzer.ts` exporting a function that takes `WalkEntry[]` and returns a typed result
2. Add the result type to `src/types.ts` and include it in `StaticAnalysisResult`
3. Call it from `src/phases/staticAnalysis.ts`
4. Add a scoring function in `src/phases/scoring.ts`
5. Add the new weight to both `SCORING_WEIGHTS` and `SCORING_WEIGHTS_NO_EMPIRICAL` in `src/constants.ts`
6. The report generator picks up category scores automatically

**Adding a new CLI flag:**
1. Add the option to `src/index.ts` (commander)
2. Add the field to `CliOptions` in `src/types.ts`
3. Pass it through `runner.ts`

**Adding a new subcommand:**
1. Create `src/commands/my-command.ts` with the handler function
2. Add `program.command('my-command')` in `src/index.ts`
3. Subcommands use positional args (not `--path`) to avoid conflicts with the parent's `--path` option

**Adding a scoring profile:**
1. Add the profile to `SCORING_PROFILES` in `src/constants.ts` — weights must sum to 1.0
2. Or create `.llm-sense/profile.json` in the target repo with `{ "name": "...", "weights": { ... } }`
3. Use `--profile <name>` to activate

**Output format branching:**
- When `--format json`, `--format summary`, or `--format html`, all progress goes to stderr via the `log` function in runner.ts
- Only the machine-readable output (JSON blob, summary line, or HTML document) goes to stdout
- This enables `llm-sense --format json > result.json` and `llm-sense --format html > report.html` to work cleanly
- When `--compare` is active with JSON/HTML format, only the comparison output goes to stdout (not both)
- HTML report is self-contained: all CSS/JS/SVG inlined, no external dependencies, <130KB typical

**Auto-fix flow:**
1. Run normal analysis (Phase 1-5)
2. Select recommendation(s) via `--fix-id` or `--fix-count`
3. For each: create worktree → build prompt from recommendation → call Claude Code → re-score → show diff → merge if improved
4. Requires git repo (worktree isolation). Non-git repos cannot use `--fix`
5. `--dry-run` skips the merge step; `--yes` skips confirmation prompts

**Auto-improve loop flow:**
1. Run full analysis → get score and recommendations
2. Pick top recommendation by impact
3. Run `runAutoFix()` with `--yes` (auto-merge if improved)
4. Re-analyze → get new score → repeat until target reached or budget/iteration cap hit
5. Skips recommendations that failed in previous iterations
6. Uses fixed cost estimates per call type ($0.10 structured, $0.30 agent)

**Context window profiling:**
- `buildContextWindowProfile()` in `fs.ts` computes coverage at 32K/100K/200K/1M tiers
- Reuses `buildTokenHeatmap()` for total token counts
- Verdicts: <50% = "Insufficient", 50-80% = "Partial", 80-95% = "Good", 95%+ = "Full"
- Always shown in reports and available via MCP `get_context_profile` tool

**AI-generated config files:**
- `llm-sense init` generates 31 AI tool config files via the registry in `src/configs/registry.ts`
- When Claude CLI is available, the 4 main formats (CLAUDE.md, .cursorrules, copilot-instructions.md, AGENTS.md) use AI-powered generation via `callClaudeStructured()`
- All other formats (27 tools) use template-based generation from the registry's `templateFn`
- Falls back to template-based generation for all formats when Claude is not installed
- Uses stratified sample of 30 files + directory summary as context
- `--tools cursor,windsurf,gemini` generates only selected formats
- `--list` shows all 31 supported formats with tier/stability info
- `--detect` scans for existing configs and generates only missing ones

**Adding a new AI tool config format:**
1. Add the format definition to `CONFIG_REGISTRY` in `src/configs/registry.ts`
2. Set `id`, `name`, `filePath`, `category` (markdown/yaml/json/custom), `tier` (1-3), `stable`
3. Implement `templateFn(ctx: ConfigContext)` returning the config file content
4. Implement `detectExisting(rootDir)` returning whether the file already exists
5. Optionally add an AI generator in the `AI_GENERATORS` map in `src/commands/init.ts` (only for major formats)

**Large codebase scaling patterns:**
- `stratifiedSample()` in `fs.ts` groups files by top-level directory and samples proportionally — use it anywhere you need a representative subset of source files
- `buildDirectorySummary()` produces a directory-level overview with file counts — preferred over flat file lists for prompts targeting large repos
- Analyzers that sample files (imports, documentation) use stratified sampling with caps that scale by repo size (e.g., 200 files for small repos, 400 for 500+ file repos)
- Token efficiency scoring uses a log-scaled baseline (`5000 + 8000 * log2(fileCount)`) so large repos aren't penalized for needing more context
- Task success requires both no errors AND file correctness >= 50% overlap with expected files

**File classification system:**
- Files >500 lines are classified as `code`, `data`, or `vendored` in `fileSizes.ts`
- `isDataFile()` in `fs.ts` samples 16KB and checks if >80% of lines are data-like (object literals, arrays) vs logic (functions, control flow)
- `isVendoredFile()` in `fs.ts` checks first 1KB for copyright headers, license markers, version banners
- Classifications drive recommendation types: data → "extract to JSON", vendored → "replace with package", code → "split into modules"
- `codeFilesOver1000Lines` excludes data/vendored from the giant file scoring penalty
- Test files (`.test.ts`, `.spec.ts`, paths containing `tests/`) get test-specific split advice

**Architecture-aware analysis:**
- Scoring reads CLAUDE.md content for modular architecture patterns (`modular monolith`, `self-contained module`, `each module is/has`)
- If modular architecture is detected OR barrel exports >20, single-file directory penalties are suppressed
- Naming uses per-directory convention detection — groups files by top-level directory, finds accepted conventions per group
- Single-word all-lowercase names (`index`, `types`, `utils`) are excluded from naming analysis since they don't demonstrate a convention
- Conventions with ≥10% representation in a directory group are accepted (handles React PascalCase + camelCase hooks)

**Claude CLI invocation modes:**
- `callClaudeStructured<T>()` — uses `--json-schema` for validated output (Phases 2-3)
- `callClaude()` — full agent mode with tools (Phase 4, Phase 7 auto-fix)
- `callClaudeJSON<T>()` — prompt-based JSON with Zod validation (fallback)

## Testing

No automated test suite yet. Manual testing against real codebases:
```bash
npm run build && node dist/index.js --skip-empirical --path /path/to/repo

# Full E2E with empirical (uses --bugs 2 --features 2 for speed)
npm run build && node dist/index.js --bugs 2 --features 2 --path /path/to/repo

# Large repos — use --concurrency for parallel task execution
npm run build && node dist/index.js --bugs 2 --features 2 --concurrency 3 --path /path/to/large-repo

# Test JSON output piping
npm run build && node dist/index.js --skip-empirical --format json --path /path/to/repo > result.json

# Test exit codes (CI use case)
npm run build && node dist/index.js --skip-empirical --format summary --min-score 70 --path /path/to/repo; echo "Exit: $?"

# Test auto-fix dry run
npm run build && node dist/index.js --skip-empirical --fix --dry-run --fix-id rec-1 --path /path/to/git-repo

# Test comparison
npm run build && node dist/index.js --skip-empirical --compare /path/to/other-repo --path /path/to/repo

# Test init scaffolding (all 31 formats)
npm run build && node dist/index.js init /path/to/repo

# Test init — list supported formats
npm run build && node dist/index.js init --list

# Test init — detect existing and generate missing
npm run build && node dist/index.js init --detect /path/to/repo

# Test init — specific tools only
npm run build && node dist/index.js init --tools cursor,windsurf,gemini /path/to/repo

# Test HTML report output
npm run build && node dist/index.js --skip-empirical --format html --path /path/to/repo > report.html

# Test HTML comparison view
npm run build && node dist/index.js --skip-empirical --compare /path/to/other-repo --format html --path /path/to/repo > comparison.html

# Test PR delta prediction
npm run build && node dist/index.js --pr-delta --format json --path /path/to/git-repo

# Test auto-improve (dry run)
npm run build && node dist/index.js --auto-improve --target 80 --max-iterations 3 --dry-run --path /path/to/git-repo

# Test custom scoring profile
npm run build && node dist/index.js --skip-empirical --profile strict --path /path/to/repo

# Test context window profiling (included in JSON output)
npm run build && node dist/index.js --skip-empirical --format json --path /path/to/repo | jq '.contextProfile'

# Test language checks (included in JSON output)
npm run build && node dist/index.js --skip-empirical --format json --path /path/to/repo | jq '.languageChecks'

# Test AST analysis (tree-sitter) — check Code Quality findings
npm run build && node dist/index.js --skip-empirical --format json --path /path/to/ts-repo | jq '.categories[] | select(.name == "Code Quality")'

# Test --no-ast fallback (regex only)
npm run build && node dist/index.js --skip-empirical --no-ast --format summary --path /path/to/repo
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
- **walkDir skips dotfiles:** The file walker skips all dotfiles/dirs by design (to avoid `.git/`). Vibe coder files like `.claude/` and CI configs like `.github/workflows/` are detected separately via direct `fs.access()` / `fs.readdir()`.
- **Non-git repos:** Empirical testing uses rsync + git init for non-git repos. This is slower than worktrees. Concurrency is auto-capped at 2 for non-git repos to avoid disk thrashing. Auto-fix (`--fix`) is unavailable for non-git repos.
- **Parallel task execution:** Tasks run concurrently (default: `cpus/2`, max 5). Each task gets its own worktree so there are no conflicts. Console output interleaves but includes `[N/M]` labels.
- **Data file heuristic limitations:** `isDataFile()` reads only the first 16KB, so a file with 50 lines of imports followed by 50K lines of data will be correctly classified, but a file with data interleaved with logic throughout may not be. The 80% threshold is intentionally high to avoid false positives.
- **Vendored detection is header-based:** Only checks the first 10 lines for copyright/license patterns. Vendored files without standard headers (e.g., minified bundles with stripped comments) won't be detected — they rely on `.min.js` patterns in `GENERATED_PATTERNS` instead.
- **Naming excludes single-word names:** Files like `index.ts`, `types.ts`, `utils.ts` are classified as `unknown` and excluded from naming analysis. This is by design — they don't reveal a convention. A repo of entirely single-word filenames will get 100% naming consistency (no signal = no penalty).
- **stderr routing in JSON/summary/HTML mode:** When `--format json`, `--format summary`, or `--format html`, all chalk-colored progress output goes to stderr. Only the machine-readable output goes to stdout. This is intentional for CI piping.
- **Commander subcommand option conflicts:** The `init` subcommand uses a positional argument (`init [dir]`) instead of `--path` because Commander would confuse it with the parent program's `--path` option.
- **Exit codes:** 0 = success, 1 = score below `--min-score` threshold, 2 = analysis failure (path not found, Claude CLI error, etc.).
- **Watch mode platform support:** `fs.watch` with `recursive: true` may not work on all platforms. macOS and Windows support it natively; Linux may require `inotify` kernel support.
- **Auto-fix worktree cleanup:** Auto-fix always cleans up worktrees, even on failure. If the process is killed mid-fix, stale worktrees in `/tmp/llm-sense-wt-*` may need manual cleanup.
- **Config drift false positives:** The drift detector only matches paths containing `/` (directory separators) to avoid flagging brand names like "Express.js". Template placeholders containing `{` (e.g., `src/modules/{feature}/routes`) are skipped. Built-in npm commands (`install`, `ci`, etc.) are excluded from script validation. Workspace package.json files are checked for monorepo script resolution.
- **Token heatmap uses byte-based estimation:** Tokens are estimated as `bytes / 4` — this is rough but avoids a tokenizer dependency. Actual token counts may vary by 20-40% depending on code density.
- **Security scanning skips test files:** The secret detection regex skips files in test/fixture/mock/example directories to avoid false positives from test fixtures. Only the first 16KB of each file is scanned.
- **Scoring version tracking:** History entries include `scoringVersion` starting from v0.9.0. The trend chart shows version boundaries. Old entries without a version are treated as pre-0.9.0.
- **Init command generates 31 config files by default:** `llm-sense init` generates configs for all 31 supported AI tools. Files that already exist are skipped. Use `--overwrite` to replace existing files. Use `--tools` to generate only specific formats. Use `--detect` to scan for existing configs and fill gaps. When Claude CLI is available, AI-powered generation is used for the 4 main formats (CLAUDE.md, .cursorrules, copilot-instructions.md, AGENTS.md); all others use templates.
- **Init config format stability:** Formats marked `stable: false` in the registry may change as AI tools evolve. These are flagged with "(unstable format)" in the output. Research each tool's current config format before relying on unstable formats in CI.
- **HTML report is self-contained:** The `--format html` output inlines all CSS, JS, and SVG. No external dependencies or network requests. Typical size is 70-130KB. The report includes hand-built SVG radar charts (no chart library).
- **HTML comparison requires --compare:** `--format html --compare /path` produces a dual-radar comparison view. Without `--compare`, it produces a single-repo report.
- **DevInfra expanded scoring:** The devInfra analyzer now checks 8 areas (CI, test, linter, pre-commit, type checking, devcontainer, task discovery, observability). Total possible raw score is 20 points, scaled to 0-100 via `score * 5`. The old 5-area scoring (max 20 raw) has been rebalanced to accommodate the 3 new areas.
- **DevInfra TODO count is extrapolated:** The analyzer samples up to 200 source files for TODO/FIXME/HACK comments and extrapolates to the full repo. Large repos may show approximate counts.
- **Tree-sitter WASM grammars are downloaded on first use:** Grammar files (~2-3MB each) are cached in `~/.llm-sense/grammars/`. Requires network on first run. Supported: TypeScript, TSX, JavaScript, Python, Go, Rust, Java, Ruby, PHP. C# falls back to regex (no WASM available).
- **`--no-ast` disables tree-sitter:** Falls back to regex-only language checks. Useful in CI environments where WASM is problematic or network is unavailable.
- **AST analysis samples files for large repos:** Repos with >500 source files are sampled (stratified by directory) to keep AST parsing under ~5s. The sample is representative but not exhaustive.
- **Structural duplicate detection normalizes identifiers:** AST subtrees are hashed with identifiers replaced by `$ID`, strings by `$STR`, numbers by `$NUM`. This catches copy-paste with renamed variables. Only functions ≥5 lines are compared. Capped at 50 duplicates.
- **Call graph is intra-repo only:** The call graph tracks calls between functions defined in the repo. External library calls are not tracked. The "isolated functions" list may include functions called only from tests or via dynamic dispatch.
- **`web-tree-sitter` ESM import:** Uses `{ Parser, Language }` named exports, not default export. The WASM core is auto-located from the package.
- **Auto-improve budget tracking is approximate:** Cost tracking uses fixed estimates ($0.10 for structured calls, $0.30 for agent mode). Actual costs may vary by 2-3x depending on codebase size.
- **Custom profiles must sum to 1.0:** Profile weights that don't sum to 1.0 will produce a warning but still work (scores will be scaled up/down proportionally).
- **Language checks exclude test files from penalties:** Test/spec/fixture files are scanned but their findings don't count toward the penalty score. This avoids penalizing test fixtures that intentionally use `any`, `unwrap()`, etc.
- **PR delta requires git history:** `--pr-delta` needs at least one previous score in `.llm-sense/history.json` to compute a delta. On first run, it shows the full score with delta 0.
- **Trend chart profiles:** History entries include profile name. The `--trend` chart shows scores from all profiles intermixed — compare scores from the same profile only.
- **Context window token estimates are rough:** Tokens are estimated as `bytes / 4`. Actual token counts vary by 20-40% depending on code density. The profiling is directionally accurate but not precise.
- **Context hog recommendation suppressed for sole directories:** If a directory (e.g., `src/`) consumes >90% of tokens but there are only 1-2 top-level dirs, the "reduce context weight" recommendation is skipped — it's meaningless when that directory IS the codebase.
- **Monorepo mode is static-only:** Empirical testing (Phases 2-4) is not supported in monorepo mode. If `--bugs`/`--features` flags are passed with a detected monorepo, a warning is shown suggesting `--no-monorepo` for full analysis.
- **`--plan` flag removed in v1.3.1:** The improvement roadmap is now always included in the generated report as a "Roadmap" section. The report is the single artifact to pass to an LLM.
- **Phase 2b timeout:** LLM verification uses a 120s timeout (matching Phase 2). Large repos (500+ files) can take 60-90s for structured output calls.

## Related Repositories

- **GitHub Action:** [`gididaf/llm-sense-action`](https://github.com/gididaf/llm-sense-action) — Reusable GitHub Action for CI/CD integration. Posts PR comments with score, category breakdown, recommendations, security findings, config drift. Supports badge generation, min-score enforcement, score delta tracking. Inputs: `mode` (static/full), `min-score`, `comment`, `badge`, `badge-path`, `path`, `extra-args`. Outputs: `score`, `grade`, `json`, `delta`.
- **npm package:** [`llm-sense`](https://www.npmjs.com/package/llm-sense)

## Environment Setup

```bash
node -v   # must be >= 18
claude auth status   # must be logged in for Phases 2-4 and --fix
```

No environment variables required. All configuration via CLI flags.
