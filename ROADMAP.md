# llm-sense Roadmap: v0.8.0 → v1.0

> **Goal:** Make llm-sense the undisputed best tool for measuring and improving codebase LLM-friendliness.
> **Core thesis:** Competitors guess with heuristics. We prove it with empirical testing.
> **Status:** v0.8.0 shipped. All original milestones (CI/CD, auto-fix, static upgrades, reports, DX polish) are complete.

---

## What's Already Shipped (v0.4.0–v0.8.0)

| Feature | Version | Status |
|---------|---------|--------|
| 7-phase pipeline (static + empirical + scoring + report + auto-fix) | v0.3.0 | Done |
| `--format json/summary`, `--min-score`, exit codes | v0.4.0 | Done |
| SVG badge generation (`--badge`) | v0.4.0 | Done |
| Score history tracking + delta display | v0.4.0 | Done |
| `--fix` auto-fix mode (worktree isolation, re-scoring) | v0.5.0 | Done |
| `--plan` improvement roadmap | v0.5.0 | Done |
| Coupling analyzer (dependency graph, fan-in/out, hub files) | v0.6.0 | Done |
| DevInfra analyzer (CI, tests, linting, type checking) | v0.6.0 | Done |
| 10-category scoring with rebalanced weights | v0.6.0 | Done |
| `--compare` repo comparison | v0.7.0 | Done |
| `--trend` historical trend chart | v0.7.0 | Done |
| `--interactive` post-analysis menu | v0.8.0 | Done |
| `--watch` live re-scoring on file changes | v0.8.0 | Done |
| `llm-sense init` (CLAUDE.md scaffolding) | v0.8.0 | Done |

---

## Competitive Landscape (April 2026)

| Competitor | Stars | Approach | What They Have That We Don't |
|------------|-------|----------|------------------------------|
| **Factory.ai** | N/A (SaaS) | 8 pillars, 5 maturity levels | Security scoring, monorepo support, maturity levels |
| **@microsoft/agentrc** | ~709 | 9 pillars, CI drift detection, VS Code ext | Config generation for all tools, VS Code extension |
| **@aiready/cli** | ? | 0-100 offline score | Semantic duplicate detection, context fragmentation |
| **@kodus/agent-readiness** | ~30 | 39 checks, radar chart | Interactive web dashboard, monorepo detection |
| **@rely-ai/caliber** | ? | Config drift detection | Grounding/accuracy checks (do referenced paths exist?) |
| **agentlinter** | ? | CLAUDE.md 5-dimension scoring | Token heatmap, freshness/staleness detection |
| **CodeScene** | N/A (SaaS) | Code Health + MCP server | MCP server (AI agents query during coding) |

**Our moat (still unique):** Empirical testing — no competitor generates synthetic tasks and runs an LLM against the codebase. Academic validation: arXiv 2601.02200 confirms code health directly impacts AI tool effectiveness.

---

## Design Principles (Unchanged)

1. **Prove, don't guess** — Empirical testing is the differentiator
2. **Lean core** — 4 npm dependencies. No tree-sitter, no heavy libs
3. **Solo-developer pace** — Every milestone shippable by one person
4. **Claude-only** — Deep Claude Code integration, no multi-model abstraction
5. **Free breakage** — Pre-1.0 semver, clean architecture over backward compatibility

---

## Milestone 6: Close the Gaps (v0.9.0)

**Theme:** Steal every good idea from competitors. Match them on static analysis, then beat them with empirical.

### 6.1 Config Drift Detection

**What:** Detect when CLAUDE.md / .cursorrules / AGENTS.md references files, directories, commands, or patterns that no longer exist in the codebase.

**Why:** @rely-ai/caliber and agents-lint both do this. It's a real problem — stale configs actively mislead LLMs. This is low-hanging fruit with high impact.

**How it works:**
1. Parse config files for path-like references (regex: paths with `/`, file extensions, directory names)
2. Parse for command references (regex: `npm run ...`, `npx ...`, `make ...`, shell commands)
3. Check each reference against the actual filesystem and package.json scripts
4. Compute a "freshness score" (0-100): ratio of valid references to total references
5. Flag stale references in findings with exact line numbers

**Scoring integration:**
- Add `configFreshness` as a sub-metric of Documentation category
- Stale configs penalize documentation score: -2 pts per stale reference (capped at -20)
- 100% fresh configs: +5 bonus pts

**Implementation:**
- New function `detectConfigDrift()` in `src/analyzers/documentation.ts` (~80 lines)
- Regex patterns for path extraction: `/src/...`, `./...`, file names with extensions
- Regex patterns for commands: backtick-wrapped commands, `npm run X`, `make X`
- `fs.existsSync()` for path validation, package.json scripts check for commands
- Add `ConfigDriftResult` to types: `{ totalReferences: number, validReferences: number, staleReferences: StaleRef[], freshnessScore: number }`

**Output in report:**
```
Config Drift: 3 stale references found in CLAUDE.md
  Line 42: `src/utils/helpers.ts` — file not found (deleted?)
  Line 87: `npm run lint` — no "lint" script in package.json
  Line 103: `src/middleware/` — directory not found
```

---

### 6.2 Token Budget Heatmap

**What:** Show which files/directories consume the most LLM context budget, helping developers prioritize what to split or exclude.

**Why:** agentlinter has this. For large repos, knowing "src/generated/ burns 40% of your context budget" is immediately actionable.

**How it works:**
1. Estimate token count per file (chars / 4 as rough estimate — no tokenizer dependency needed)
2. Aggregate by top-level directory
3. Rank by token consumption (descending)
4. Show percentage of total budget consumed
5. Flag directories consuming >25% as "context hogs"

**Output:**
```
Token Budget Heatmap (estimated):
  src/components/    34,200 tokens  (28%) ████████████░░░░░░  ⚠️ context hog
  src/services/      18,400 tokens  (15%) ██████░░░░░░░░░░░░
  src/utils/         12,100 tokens  (10%) ████░░░░░░░░░░░░░░
  src/types/          8,300 tokens   (7%) ███░░░░░░░░░░░░░░░
  ...
  Total: ~122,000 tokens across 847 source files
```

**Implementation:**
- New function `buildTokenHeatmap()` in `src/core/fs.ts` (~40 lines)
- Reuse existing `walkDir` + `countLines` infrastructure
- Token estimate: `fileContent.length / 4` (good enough for heuristic; avoids tiktoken dependency)
- Add to report generator as a new section (shown when `--verbose` or always in JSON output)
- Add `TokenHeatmap` type to types.ts: `{ entries: Array<{ path: string, tokens: number, percentage: number }>, total: number }`

**Scoring integration:**
- No new scoring category — this is a diagnostic/recommendation tool
- Feed into recommendations: "Consider splitting src/components/ (28% of context budget) into smaller modules"

---

### 6.3 Security Scoring (Lightweight)

**What:** Detect basic security anti-patterns that make a codebase riskier for LLM-assisted development. Not a full SAST tool — just the things that matter for AI coding safety.

**Why:** Factory.ai and Kodus both score security. LLMs can accidentally expose secrets or amplify insecure patterns. This is table stakes for enterprise adoption.

**Checks:**

| Check | Detection Method | Points Deducted |
|-------|-----------------|-----------------|
| `.env` file committed (not in .gitignore) | Check .gitignore for `.env`, check if `.env` exists | -10 |
| Hardcoded secrets in source | Regex: `(api[_-]?key\|secret\|password\|token)\s*[:=]\s*['"][^'"]{8,}` | -5 per file (cap -20) |
| No `.gitignore` | `fs.existsSync('.gitignore')` | -5 |
| Sensitive files tracked | Check if `*.pem`, `*.key`, `credentials.*`, `secrets.*` exist in tree | -5 per file (cap -15) |
| Dependency lockfile missing | No lockfile but has dependency file | -5 |

**Baseline:** 100 pts, subtract penalties. Floor at 0.

**Implementation:**
- New file: `src/analyzers/security.ts` (~100 lines)
- Pure filesystem checks + regex on sampled files (use `stratifiedSample()` to avoid reading entire repo)
- Add `SecurityResult` to types.ts
- Add to `StaticAnalysisResult`
- Call from `staticAnalysis.ts`
- New scoring category: "Security" with weight allocation (see 6.7)

---

### 6.4 Complete Multi-AI-Config Init

**What:** Finish the `init` command to generate config files for all major AI coding tools, not just CLAUDE.md.

**Why:** @microsoft/agentrc and rulesync both do this. Our init command currently only generates CLAUDE.md — the types and detection for other tools exist but the generation doesn't.

**Files to generate:**

| File | When to generate | Content |
|------|-----------------|---------|
| `CLAUDE.md` | Always | Full 8-section template (already works) |
| `.cursorrules` | Always (Cursor is dominant) | Project context, coding conventions, file structure hints |
| `.github/copilot-instructions.md` | If `.github/` dir exists | Same content as CLAUDE.md, adapted for Copilot format |
| `AGENTS.md` | If monorepo or large project | Module-level instructions for autonomous agents |

**Content synthesis:**
- Reuse Phase 1 static analysis results to populate templates
- Detect tech stack (TypeScript/Python/Go/Rust/etc.) from file extensions
- Detect framework (React/Next.js/Express/Django/etc.) from dependency files
- Detect testing framework from devInfra analyzer
- Fill in build/run/test commands from package.json/Makefile

**Implementation:**
- Extend `src/commands/init.ts` — add generators for each file type (~100 lines)
- Add templates to `src/constants.ts` for each config file format
- Add `--init-all` flag to generate all files at once (default: prompt which ones)
- Skip files that already exist (warn user, offer `--overwrite`)

---

### 6.5 Populate estimatedEffort and dependsOn in Recommendations

**What:** Fill in the two recommendation fields that are defined in the type system but never populated.

**Why:** These fields exist in `ExecutableRecommendation` but are always `undefined`. The `--plan` output would be much more useful with effort estimates, and `--fix` could respect dependencies.

**Effort estimation heuristic:**

| Recommendation Type | Default Effort |
|---------------------|---------------|
| Create CLAUDE.md from scratch | 30min |
| Add missing CLAUDE.md section | 5min |
| Add inline comments | 2hr |
| Split file >1000 lines | 30min per file |
| Split file >500 lines | 5min per file |
| Add barrel exports | 5min |
| Remove generated/dead files | 5min |
| Add CI config | 30min |
| Add test command | 30min |
| Add linter | 30min |
| Fix naming inconsistency | 5min per file |

**Dependency rules:**
- "Add test command" must precede "Add CI config" (CI needs tests to run)
- "Create CLAUDE.md" must precede "Add CLAUDE.md sections"
- "Add linter" should precede "Fix naming inconsistency" (linter enforces conventions)

**Implementation:**
- Modify `src/report/recommendations.ts` — add effort lookup table + dependency graph (~50 lines)
- Update `generatePlan()` to sort by effort-adjusted ROI: `impact / effortMinutes`
- Update `--fix` in `autoFix.ts` to respect `dependsOn` ordering

---

### 6.6 Deeper AI Config File Scoring

**What:** Upgrade the multi-AI-config scoring from basic existence detection to actual content quality analysis.

**Why:** The types for `aiConfigScores` exist but the implementation is minimal. agentlinter scores CLAUDE.md across 5 dimensions — we should score all config files across our 8 sections.

**Approach:**
- Apply the same 8-section keyword analysis used for CLAUDE.md to:
  - `.cursorrules` (free-form text — look for same keywords)
  - `.github/copilot-instructions.md` (markdown — identical analysis)
  - `AGENTS.md` (markdown — identical analysis)
  - `.clinerules` (free-form text — same as .cursorrules)
- New sub-metric: "AI Config Coverage" — how many major tools have config files?
  - 0 tools: 0 pts
  - 1 tool: 3 pts
  - 2 tools: 5 pts
  - 3+ tools: 8 pts
- Cross-file consistency check: do different config files mention the same tech stack, conventions, and commands? Inconsistency penalty: -2 pts per contradiction found

**Implementation:**
- Extract `scoreConfigSections()` from CLAUDE.md-specific code in `src/analyzers/documentation.ts` into a generic function
- Call it for each detected config file
- Add `aiConfigCoverage` and `aiConfigConsistency` to documentation sub-scores
- Adjust documentation category max points to accommodate (~15 lines changed)

---

### 6.7 Weight Rebalancing for v0.9.0

Add Security category and adjust weights:

**Empirical mode:**
```
documentation:      0.17  (was 0.18 — AI config scoring adds depth within this category)
taskCompletion:     0.18  (was 0.20 — still dominant, slightly reduced)
fileSizes:          0.10  (was 0.12)
structure:          0.07  (was 0.08)
modularity:         0.09  (was 0.10)
contextEfficiency:  0.07  (was 0.08)
tokenEfficiency:    0.10  (unchanged)
naming:             0.04  (unchanged)
devInfra:           0.05  (unchanged)
coupling:           0.05  (unchanged)
security:           0.08  (NEW)
```

**Static-only mode:**
```
documentation:      0.22  (was 0.25)
fileSizes:          0.15  (was 0.17)
structure:          0.09  (was 0.10)
modularity:         0.11  (was 0.13)
contextEfficiency:  0.10  (was 0.13)
naming:             0.06  (was 0.07)
devInfra:           0.07  (was 0.08)
coupling:           0.06  (was 0.07)
security:           0.14  (NEW — higher weight in static mode since no empirical validation)
```

**History compatibility:** Add `scoringVersion: "0.9.0"` to `HistoryEntry`. Trend chart shows version boundaries. Only compare scores from same scoring version.

---

## Milestone 7: Distribution & Ecosystem (v0.10.0)

**Theme:** Put llm-sense where developers already are.

### 7.1 GitHub Action (Published)

**What:** A real, published GitHub Action in `gididaf/llm-sense-action` that teams can drop into any repo.

**Why:** This is the #1 missing piece for team adoption. agentrc and Kodus both have CI integration. We have the JSON output and exit codes — we just need the Action wrapper.

**Action inputs:**

```yaml
inputs:
  mode:
    description: "Analysis mode: 'static' (fast, free) or 'full' (empirical, needs API key)"
    default: "static"
  min-score:
    description: "Minimum passing score (0-100). PR check fails if below."
    default: "0"
  comment:
    description: "Post score as PR comment"
    default: "true"
  badge:
    description: "Generate and commit badge SVG"
    default: "false"
  path:
    description: "Path to analyze (relative to repo root)"
    default: "."
```

**Action implementation:**

```yaml
# action.yml
name: 'LLM-Sense'
description: 'Analyze codebase LLM-friendliness'
branding:
  icon: 'cpu'
  color: 'blue'
runs:
  using: 'composite'
  steps:
    - uses: actions/setup-node@v4
      with:
        node-version: '18'
    - run: npx llm-sense@latest --format json --min-score ${{ inputs.min-score }} --path ${{ inputs.path }} ${{ inputs.mode == 'static' && '--skip-empirical' || '' }} > llm-sense-result.json
      shell: bash
    - uses: actions/github-script@v7
      if: inputs.comment == 'true' && github.event_name == 'pull_request'
      with:
        script: |
          // Read result, format PR comment, post/update
```

**PR comment format:**
```markdown
## LLM-Sense: 74/100 (B)  [+3 since last run]

| Category | Score | Weight |
|----------|-------|--------|
| Documentation | 82 | 17% |
| Task Completion | — | (static mode) |
| File Sizes | 71 | 10% |
| Structure | 68 | 7% |
| Modularity | 75 | 9% |
| Context Efficiency | 88 | 7% |
| Naming | 92 | 4% |
| Coupling | 65 | 5% |
| Dev Infrastructure | 80 | 5% |
| Security | 90 | 8% |

**Top recommendation:** Add architecture overview to CLAUDE.md (+8 pts est.)

<details><summary>Full JSON</summary>

```json
{ ... }
```

</details>
```

**Deliverables:**
- New repo: `gididaf/llm-sense-action`
- `action.yml` — composite action definition (~80 lines)
- `comment.js` — PR comment builder (~60 lines)
- `README.md` — usage docs with examples
- Publish to GitHub Marketplace

---

### 7.2 MCP Server Mode

**What:** Run llm-sense as an MCP (Model Context Protocol) server that AI coding agents can query in real-time while working on a codebase.

**Why:** CodeScene has an MCP server (31 stars). MCP is the emerging standard for AI tool integration. If Claude Code / Cursor can query llm-sense during coding sessions, we become infrastructure, not just a one-shot tool.

**MCP tools exposed:**

| Tool | Description | Use Case |
|------|-------------|----------|
| `get_score` | Returns current overall score + category breakdown | Agent checks score before/after changes |
| `get_recommendations` | Returns top N recommendations | Agent decides what to work on |
| `check_file` | Scores a single file (size, naming, comments) | Agent checks if a file it wrote meets standards |
| `check_drift` | Validates config file references | Agent verifies CLAUDE.md accuracy after edits |
| `get_heatmap` | Returns token budget heatmap | Agent knows which areas are context-heavy |

**Implementation approach:**
- New file: `src/mcp/server.ts` (~150 lines)
- Use stdin/stdout JSON-RPC (MCP protocol) — no HTTP server dependency
- Reuse existing analyzers for each tool
- Cache Phase 1 results; invalidate on file changes (reuse watch infrastructure)
- Entry point: `llm-sense serve` subcommand

**Configuration for Claude Code:**
```json
// .claude/mcp_servers.json
{
  "llm-sense": {
    "command": "npx",
    "args": ["llm-sense", "serve"],
    "cwd": "."
  }
}
```

**No new dependencies:** MCP protocol is simple JSON-RPC over stdio. Parse/emit JSON manually (~30 lines of protocol handling).

---

### 7.3 Monorepo Support

**What:** Score individual packages/modules within a monorepo independently, then produce an aggregate score.

**Why:** Factory.ai and Kodus both support monorepos. Large orgs (the kind that drive team adoption) almost always use monorepos.

**Detection:** A repo is a monorepo if it has:
- `packages/` or `apps/` directory with multiple subdirectories containing `package.json`
- `pnpm-workspace.yaml` or `lerna.json` or `turbo.json`
- Multiple `go.mod` files at different depths

**Behavior:**
```bash
llm-sense --path /path/to/monorepo
# Detects monorepo, asks: "Analyze entire repo or individual packages?"
# Or: llm-sense --path /path/to/monorepo --monorepo
# Forces per-package analysis
```

**Output:**
```
Monorepo Analysis: my-platform

| Package | Score | Grade | Top Issue |
|---------|-------|-------|-----------|
| packages/api | 78 | B | Missing CLAUDE.md |
| packages/web | 65 | C | 3 files >1000 lines |
| packages/shared | 82 | B | Low test coverage |
| packages/cli | 71 | B | Naming inconsistency |
| **Aggregate** | **74** | **B** | |
```

**Implementation:**
- New file: `src/core/monorepo.ts` (~60 lines) — detection + package discovery
- Modify `src/phases/runner.ts` — if monorepo detected, loop over packages
- Each package scored independently using existing pipeline
- Aggregate score: weighted average by file count (larger packages matter more)
- Add `--monorepo` flag to force per-package analysis
- Add `MonorepoResult` to types.ts

---

## Milestone 8: Intelligence Layer (v1.0.0)

**Theme:** Go beyond what static analysis can see. Use the LLM to understand things heuristics can't.

### 8.1 Semantic Duplicate Detection

**What:** Find files that serve the same purpose or contain overlapping logic, even if they have different names and implementations.

**Why:** @aiready/cli does this. Duplicated logic confuses LLMs (they don't know which version to use/modify). It's also a code quality signal.

**Approach (no new dependencies):**
1. Group files by similar size (within 30% of each other)
2. For each group, compute a simple "content fingerprint": sorted set of exported function/class names (regex-extracted)
3. Files with >60% fingerprint overlap are flagged as potential duplicates
4. For empirical mode: include duplicate pairs in the Phase 2 prompt and ask Claude to confirm which are true duplicates

**Implementation:**
- New file: `src/analyzers/duplicates.ts` (~100 lines)
- Extract exports via regex: `export (function|class|const|type|interface) (\w+)`
- Jaccard similarity on export name sets
- Add to `StaticAnalysisResult`
- Feed confirmed duplicates into recommendations: "Consolidate X and Y into a single module"

---

### 8.2 Context Fragmentation Score

**What:** Measure how scattered related logic is across the codebase. High fragmentation means an LLM needs more context to understand a feature.

**Why:** @aiready/cli scores this. It directly predicts how many files an LLM needs to read to complete a task.

**Approach:**
1. Use the existing dependency graph (coupling analyzer) to identify clusters
2. A "cluster" is a set of files that import each other heavily (connected component with edge weight > 1)
3. Fragmentation = ratio of inter-cluster imports to intra-cluster imports
4. High fragmentation (lots of cross-cluster imports) = bad for LLMs
5. Low fragmentation (most imports within clusters) = good for LLMs

**Scoring:**
- Fold into existing "Coupling" category as a sub-metric
- Fragmentation ratio < 0.3: +10 bonus
- Fragmentation ratio > 0.6: -10 penalty

**Implementation:**
- Add `computeFragmentation()` to `src/analyzers/imports.ts` (~50 lines)
- Uses existing adjacency graph — just needs connected component detection (BFS, ~20 lines)
- No new scoring category — enhances Coupling

---

### 8.3 LLM-Verified Scoring

**What:** In empirical mode, use the LLM to validate/adjust static analysis findings. Static heuristics can miss nuance — the LLM can catch what regex can't.

**Why:** This turns our empirical advantage into an unfair advantage. No competitor can do this because they don't invoke LLMs.

**What the LLM verifies:**
1. **Documentation quality:** "Is this CLAUDE.md actually helpful, or is it boilerplate?" (heuristic might score boilerplate highly if it has the right keywords)
2. **Naming assessment:** "Are these function/file names clear and descriptive?" (regex can check convention consistency but not semantic clarity)
3. **Architecture clarity:** "Can you understand the codebase structure from the directory layout alone?" (score 1-10)

**Implementation:**
- Add an optional "LLM verification" sub-phase to Phase 2
- Send a focused prompt with sampled files + directory tree
- Parse structured response (Zod schema) with adjustment factors
- Apply adjustments: each LLM-verified category can shift ±15 points from static score
- Only runs in full mode (not `--skip-empirical`)
- Cost: ~$0.02 per verification (single Claude call with short prompt)

---

### 8.4 Incremental Analysis

**What:** Only re-analyze files that changed since the last run. Dramatically speeds up watch mode and CI.

**Why:** Full analysis takes ~300ms for static, but for large repos it's 1-3 seconds. In CI, running on every commit matters. In watch mode, re-analyzing unchanged files is waste.

**Approach:**
1. After each run, save a manifest: `{ filePath: mtime }` in `.llm-sense/manifest.json`
2. On next run, compare mtimes. Only re-walk changed/new/deleted files
3. Merge with cached results for unchanged files
4. Invalidate dependent scores (e.g., if a file in src/utils/ changed, re-run coupling analysis for that cluster)

**Implementation:**
- New file: `src/core/cache.ts` (~80 lines)
- Manifest: `Record<string, number>` (path → mtime)
- `getChangedFiles(manifest, walkEntries)` returns delta
- Modify `staticAnalysis.ts` to accept optional cached results
- Add `--no-cache` flag to force full re-analysis

---

## Version Plan Summary

| Version | Codename | Key Features | Theme |
|---------|----------|-------------|-------|
| **v0.9.0** | Fortress | Config drift, token heatmap, security scoring, complete init, recommendation effort/deps, deeper AI config scoring | Close competitive gaps |
| **v0.10.0** | Ecosystem | GitHub Action, MCP server, monorepo support | Be everywhere developers are |
| **v1.0.0** | Intelligence | Semantic duplicates, context fragmentation, LLM-verified scoring, incremental analysis | Unfair advantages no one can match |

---

## File Impact Map

### New files:

```
src/
├── analyzers/
│   ├── security.ts              # v0.9.0: secret detection, .env checks
│   └── duplicates.ts            # v1.0.0: semantic duplicate detection
├── mcp/
│   └── server.ts                # v0.10.0: MCP server for AI tool integration
└── core/
    ├── monorepo.ts              # v0.10.0: monorepo detection + package discovery
    └── cache.ts                 # v1.0.0: incremental analysis cache

# Separate repo:
gididaf/llm-sense-action/
├── action.yml                   # v0.10.0: GitHub Action definition
├── comment.js                   # v0.10.0: PR comment builder
└── README.md                    # v0.10.0: Action documentation
```

### Modified files:

```
src/index.ts                     # v0.9.0: --no-cache flag; v0.10.0: `serve` + `--monorepo`
src/types.ts                     # Every version: new result types
src/constants.ts                 # v0.9.0: weight rebalance + security weights
src/phases/runner.ts             # v0.10.0: monorepo loop; v1.0.0: incremental path
src/phases/scoring.ts            # v0.9.0: security category; v1.0.0: fragmentation sub-metric
src/phases/staticAnalysis.ts     # v0.9.0: security analyzer; v1.0.0: duplicates + cache
src/phases/llmUnderstanding.ts   # v1.0.0: LLM verification sub-phase
src/analyzers/documentation.ts   # v0.9.0: drift detection + deeper AI config scoring
src/analyzers/imports.ts         # v1.0.0: fragmentation scoring
src/commands/init.ts             # v0.9.0: multi-tool config generation
src/report/recommendations.ts    # v0.9.0: effort + dependency population
src/report/generator.ts          # v0.9.0: token heatmap section; v0.10.0: monorepo report
src/core/fs.ts                   # v0.9.0: buildTokenHeatmap()
src/core/history.ts              # v0.9.0: scoringVersion field
```

---

## No New Dependencies Policy (Continued)

| Feature | Approach |
|---------|----------|
| Config drift detection | Regex path extraction + `fs.existsSync()` |
| Token heatmap | `content.length / 4` (chars-to-tokens estimate) |
| Security checks | Regex for secret patterns + `.gitignore` parsing |
| MCP server | JSON-RPC over stdin/stdout (manual parsing, ~30 lines) |
| Monorepo detection | Glob for `packages/*/package.json` + workspace file checks |
| Semantic duplicates | Export name extraction via regex + Jaccard similarity |
| Context fragmentation | BFS connected components on existing dependency graph |
| Incremental cache | `fs.statSync().mtimeMs` + JSON manifest |

**Total dependency count after v1.0.0: still 4** (chalk, commander, zod, zod-to-json-schema)

---

## Risk Mitigations

| Risk | Mitigation |
|------|-----------|
| Security regex has false positives (matches test fixtures, examples) | Skip files in test directories; require 8+ char values; ignore comments |
| MCP protocol changes | Pin to MCP spec version; protocol is simple enough to adapt quickly |
| Monorepo analysis too slow | Run packages in parallel (reuse concurrency pool); cache per-package results |
| Config drift regex over-extracts | Only flag references that look like paths (contain `/` or `.`) and fail existence check |
| LLM-verified scoring adds cost | Optional, only in full mode. Single call ~$0.02. Document cost in `--verbose` output |
| Incremental cache stale | Always full-reanalyze on scoring version change. `--no-cache` escape hatch |
| Semantic duplicate false positives | Require >60% export overlap AND similar file size. LLM confirmation in full mode |

---

## Success Metrics for v1.0.0

After the full roadmap, llm-sense should:

- [x] Score any codebase 0-100 with static analysis
- [x] Empirically test LLM coding ability on the codebase
- [x] Auto-fix issues and prove the improvement
- [x] Compare repos and show trends over time
- [x] Work interactively with live feedback
- [x] **Detect stale config file references** (beats caliber, agents-lint)
- [x] **Show token budget heatmap** (beats agentlinter)
- [x] **Score security posture** (matches Factory.ai, Kodus)
- [x] **Generate config files for all AI tools** (matches agentrc, rulesync)
- [x] **Run as GitHub Action with PR comments** (matches agentrc, Kodus)
- [x] **Serve as MCP server for real-time AI integration** (matches CodeScene)
- [x] **Analyze monorepos per-package** (matches Factory.ai, Kodus)
- [x] **Detect semantic duplicates** (beats @aiready/cli)
- [x] **Score context fragmentation** (beats @aiready/cli)
- [x] **LLM-verify static findings** (unique — no competitor can do this)
- [x] **Incremental analysis for speed** (unique for this tool class)

**The v1.0 end state:** llm-sense matches or beats every competitor on static analysis, then leaves them behind with empirical testing, LLM-verified scoring, and MCP integration. The only tool that proves your codebase works with AI, fixes what doesn't, and integrates into your workflow at every touchpoint.
