# llm-sense — Competitive Gap Closure Plan

> 8 features to close every meaningful gap with Factory.ai, CodeScene, Ruler, and the broader AI-readiness tooling ecosystem.

## Overview

| # | Feature | Priority | Effort | Key Competitor |
|---|---------|----------|--------|----------------|
| 1 | [30+ init config formats](#1-30-init-config-formats) | P0 | Large | Ruler (33 tools), RulesForAI (15+) |
| 2 | [Expand devInfra: devcontainer, task discovery, observability](#2-expand-devinfra-analyzer) | P1 | Medium | Factory.ai (9 pillars), Kodus |
| 3 | [Tree-sitter AST analysis](#3-tree-sitter-ast-analysis) | P1 | Large | codebase-memory-mcp, code-index-mcp |
| 4 | [HTML report output](#4-html-report-output) | P1 | Medium | CodeScene, Kodus |
| 5 | [HTML comparison view](#5-html-comparison-view) | P1 | Small | CodeScene dashboards |
| 6 | [Published benchmarks](#6-published-benchmarks) | P1 | Medium | CodeScene (peer-reviewed paper) |
| 7 | [Deferred: Continuous learning](#7-deferred-continuous-learning) | — | — | claude-reflect |
| 8 | [Deferred: VS Code extension](#8-deferred-vs-code-extension) | — | — | SonarQube, Codacy |

---

## 1. 30+ Init Config Formats

**Goal:** Match Ruler's 33-tool coverage. Users on any AI coding tool can run `llm-sense init` and get a config file.

**Current state:** 4 formats (CLAUDE.md, .cursorrules, copilot-instructions.md, AGENTS.md).

### Target formats (30+)

Each format needs: (a) a file path/name, (b) a template fallback, (c) an AI-generation prompt variant.

**Tier 1 — Major tools (already have):**
1. `CLAUDE.md` — Claude Code
2. `.cursorrules` — Cursor
3. `.github/copilot-instructions.md` — GitHub Copilot
4. `AGENTS.md` — OpenAI Codex / multi-agent standard

**Tier 2 — High-priority additions:**
5. `.windsurfrules` — Windsurf (Codeium)
6. `.clinerules` — Cline
7. `devin.md` — Devin (Cognition)
8. `.amazonq/rules` — Amazon Q Developer
9. `GEMINI.md` — Google Gemini CLI
10. `.aider.conf.yml` — Aider
11. `.zed/rules` — Zed editor
12. `.continuerc.json` — Continue (open-source AI assistant)
13. `augment-guidelines.md` — Augment Code
14. `.roo/rules` or `.roorules` — Roo Code

**Tier 3 — Broad coverage:**
15. `bolt.instructions.md` — Bolt (StackBlitz)
16. `.replit/ai-rules` — Replit AI
17. `.tabnine/config.json` — Tabnine
18. `guidelines.md` — Generic AI guidelines
19. `.sourcery.yaml` — Sourcery (Python)
20. `kiro.md` or `.kiro/rules` — Kiro (AWS)
21. `.cody/config.json` — Sourcegraph Cody
22. `.double/rules` — Double (AI pair programmer)
23. `.marscode/rules` — MarsCode (ByteDance)
24. `.trae/rules` — Trae (ByteDance)
25. `MENTAT.md` — Mentat
26. `.aide/rules` — Aide
27. `.goose/config.yaml` — Goose (Block)
28. `.privy/rules` — Privy
29. `sweep.yaml` — Sweep AI
30. `.superinterface/rules` — Superinterface
31. `.codex/config` — OpenAI Codex CLI

### Architecture

**File:** `src/commands/init.ts`

Refactor the current hardcoded 4-format approach into a registry pattern:

```typescript
// src/configs/registry.ts
interface ConfigFormat {
  id: string;
  name: string;           // Human-readable tool name
  filePath: string;       // e.g., '.windsurfrules'
  category: 'markdown' | 'yaml' | 'json' | 'custom';
  templateFn: (context: ConfigContext) => string;
  aiPromptFn: (context: ConfigContext) => string;
  detectExisting: (rootDir: string) => Promise<boolean>;
}

const CONFIG_REGISTRY: ConfigFormat[] = [
  // All 30+ formats defined here
];
```

**New CLI options for `init`:**
- `llm-sense init [dir]` — generate ALL formats (default)
- `llm-sense init --tools cursor,claude,copilot` — generate only selected tools
- `llm-sense init --list` — list all supported tool formats
- `llm-sense init --detect` — scan which AI tools are configured, generate missing ones

**Key considerations:**
- Templates must be maintained. Group by category (markdown-based vs JSON vs YAML) to share logic.
- AI-generation prompts should share a common base prompt and add tool-specific instructions (e.g., "Format as YAML" for `.aider.conf.yml`).
- Many tools accept similar content (project description, conventions, tech stack). The core analysis is shared; only the output format differs.
- Some formats are unstable (tools change their config format). Add a `stable: boolean` flag to the registry and warn for unstable formats.
- Research each tool's actual config format before implementing. Some may have changed since our last research (April 2026).

### Files to modify
- `src/commands/init.ts` — refactor to use registry
- New: `src/configs/registry.ts` — format definitions
- New: `src/configs/templates/` — template files per category
- `src/types.ts` — add `ConfigFormat` types, update `CliOptions` for new init flags
- `src/index.ts` — add `--tools`, `--list`, `--detect` options to init subcommand
- `src/mcp/server.ts` — update `generate_config` tool to support new formats

### Testing
```bash
# Generate all formats
npm run build && node dist/index.js init /path/to/repo

# Generate specific tools only
npm run build && node dist/index.js init --tools cursor,windsurf,cline /path/to/repo

# List all supported formats
npm run build && node dist/index.js init --list

# Detect existing AI configs and fill gaps
npm run build && node dist/index.js init --detect /path/to/repo
```

---

## 2. Expand devInfra Analyzer

**Goal:** Add the missing "agent readiness" pillars that Factory.ai and Kodus check: devcontainer, task discovery, and observability.

**Current state:** `devInfra.ts` checks CI config, test commands, linter, pre-commit hooks, type checking. No checks for devcontainer, issue/PR templates, contribution guides, or observability patterns.

### New checks to add

**Devcontainer / Codespaces (agent environment readiness):**
- `.devcontainer/devcontainer.json` exists
- `.devcontainer/Dockerfile` or image specified
- `postCreateCommand` configured (setup automation)
- VS Code extensions pre-configured
- GitHub Codespaces config (`.devcontainer/` is sufficient)
- Docker Compose for multi-service setups

**Task Discovery (can agents find work to do?):**
- `.github/ISSUE_TEMPLATE/` directory with templates
- `.github/PULL_REQUEST_TEMPLATE.md` or `.github/PULL_REQUEST_TEMPLATE/`
- `CONTRIBUTING.md` exists and has substance (>20 lines)
- Issue labels defined (`.github/labels.yml` or via API)
- `TODO`/`FIXME`/`HACK` comment density (high = lots of discoverable work, but also tech debt signal)
- Changelog or release notes pattern (`CHANGELOG.md`, `RELEASES.md`)

**Observability (debugging/logging readiness):**
- Structured logging library detected (winston, pino, bunyan, log4j, slog, tracing, logrus, zerolog, spdlog)
- Error handling patterns (try/catch density, error boundary components)
- `.env.example` or `.env.template` for environment documentation
- Health check endpoints (for API projects)
- OpenTelemetry / tracing config detection

### Scoring integration

Fold into the existing `devInfra` scoring category (currently 5% weight). The new checks expand the category's coverage but don't change weights — they make the score more comprehensive within the same bucket.

**Scoring formula update in `scoring.ts`:**
- Current: CI (25pts) + test command (25pts) + linter (20pts) + pre-commit (15pts) + type checking (15pts) = 100
- New: CI (15pts) + test command (15pts) + linter (12pts) + pre-commit (10pts) + type checking (10pts) + devcontainer (12pts) + task discovery (14pts) + observability (12pts) = 100

### Files to modify
- `src/analyzers/devInfra.ts` — add new detection functions
- `src/types.ts` — extend `DevInfraResult` with new fields
- `src/phases/scoring.ts` — update devInfra scoring formula
- `src/report/generator.ts` — render new findings in report
- `src/report/recommendations.ts` — add recommendations for missing devcontainer/templates/logging

### Testing
```bash
# Test against repo WITH devcontainer (e.g., a well-configured OSS project)
npm run build && node dist/index.js --skip-empirical --format json --path /path/to/repo | jq '.categories[] | select(.name == "Developer Infrastructure")'

# Test against repo WITHOUT devcontainer
npm run build && node dist/index.js --skip-empirical --path /path/to/barebones-repo
```

---

## 3. Tree-sitter AST Analysis

**Goal:** Replace regex-based language checks with tree-sitter AST parsing for accurate function-level analysis, complexity scoring, and duplicate detection.

**Current state:** All language checks in `languageChecks.ts` and `duplicates.ts` use regex. This misses: function-level complexity, accurate dead code detection, precise type annotation coverage, nested control flow depth.

### Implementation plan

**Phase 3a — Add tree-sitter dependency:**
- Add `tree-sitter` and language grammar packages as dependencies
- Start with top languages: TypeScript/JavaScript, Python, Go, Rust, Java
- Add remaining languages incrementally: Ruby, PHP, Swift, C#, C/C++

**Phase 3b — AST-powered language checks (replace regex):**
- Function complexity (cyclomatic complexity per function)
- Nesting depth (max nested if/for/while depth)
- Function length distribution (lines per function)
- Type annotation coverage (% of functions with typed params/returns)
- Dead export detection (exported symbols never imported elsewhere)
- Error handling completeness (uncaught promises, empty catch blocks)
- Magic number / hardcoded string detection

**Phase 3c — AST-powered duplicate detection (enhance duplicates.ts):**
- Structural similarity (AST subtree comparison) instead of export name fingerprinting
- Copy-paste detection across files
- Near-duplicate function detection (same structure, different variable names)

**Phase 3d — New capabilities enabled by AST:**
- Function-level LLM-friendliness scoring (per-function complexity + naming + doc coverage)
- Call graph construction (more accurate than import-based)
- API surface area measurement (public exports, their complexity)
- Code-to-comment ratio per function (not just per file)

### Dependency choices

```bash
# Option A: tree-sitter (Node.js native bindings)
npm install tree-sitter tree-sitter-typescript tree-sitter-python tree-sitter-go tree-sitter-rust tree-sitter-java

# Option B: web-tree-sitter (WASM, no native compilation needed)
npm install web-tree-sitter
# + download .wasm grammar files
```

**Recommendation:** Use `web-tree-sitter` (WASM). Avoids native compilation issues on different platforms. Slightly slower than native but more portable. Grammar `.wasm` files can be bundled or downloaded on first use.

### Graceful degradation
- If tree-sitter parsing fails for a file (unsupported language, parse error), fall back to existing regex checks
- Language grammars loaded on demand (not all at startup)
- Add `--no-ast` flag to skip tree-sitter entirely (for CI environments where WASM is problematic)

### Files to modify
- New: `src/core/ast.ts` — tree-sitter wrapper (init, parse, query helpers)
- New: `src/analyzers/astChecks.ts` — AST-powered code quality checks
- `src/analyzers/languageChecks.ts` — refactor to use AST when available, regex as fallback
- `src/analyzers/duplicates.ts` — add structural similarity detection
- `src/types.ts` — add AST-related result types (FunctionComplexity, NestingDepth, etc.)
- `src/phases/scoring.ts` — update code quality scoring with new AST metrics
- `package.json` — add web-tree-sitter dependency + grammar packages
- `tsup.config.ts` — handle WASM file bundling

### Testing
```bash
# Verify AST analysis produces results
npm run build && node dist/index.js --skip-empirical --format json --path /path/to/ts-repo | jq '.languageChecks'

# Verify fallback to regex when --no-ast
npm run build && node dist/index.js --skip-empirical --no-ast --format json --path /path/to/repo | jq '.languageChecks'

# Test against multi-language repo
npm run build && node dist/index.js --skip-empirical --path /path/to/polyglot-repo
```

---

## 4. HTML Report Output

**Goal:** `--format html` produces a self-contained `.html` file with radar chart, category bars, token heatmap, and recommendations — shareable, no server needed.

**Current state:** Only markdown, JSON, and summary output formats.

### Design

Single HTML file with all CSS/JS inlined. No external dependencies. Opens in any browser.

**Sections:**
1. **Header** — repo name, score (large number), grade badge, date, profile used
2. **Radar chart** — 12 category scores on a spider/radar chart (SVG, no library)
3. **Category breakdown** — horizontal bar chart per category with score, weight, and top finding
4. **Token heatmap** — treemap or horizontal stacked bar showing directory token distribution
5. **Context window profile** — tier table (32K/100K/200K/1M) with coverage percentages
6. **Recommendations** — cards with title, impact, effort, category, expandable implementation steps
7. **Config drift** — if any stale references found
8. **Security findings** — if any
9. **Score history** — if history.json exists, show a trend sparkline
10. **Collapsible raw JSON** — full data dump at the bottom

**Styling:**
- Dark theme (matches terminal aesthetic)
- Responsive (works on mobile)
- Print-friendly (collapsible sections expand when printing)
- Color palette: green (80+), yellow (60-79), red (<60) for scores

### Architecture

**File:** `src/report/htmlOutput.ts`

The HTML generator receives the same `AnalysisResult` object as the markdown and JSON generators. It produces a single string of HTML.

```typescript
// src/report/htmlOutput.ts
export function generateHtmlReport(result: AnalysisResult): string {
  // Returns complete HTML document as string
}
```

**SVG charts:** Hand-built SVG (no chart library). The radar chart and bar charts are simple enough to generate programmatically. This keeps the HTML self-contained and small.

**Inline everything:** CSS in `<style>`, JS in `<script>`, SVG inline. Target: <100KB total for the HTML file.

### Files to modify
- New: `src/report/htmlOutput.ts` — HTML report generator
- `src/phases/runner.ts` — add `html` to format branching
- `src/types.ts` — add `'html'` to format union type
- `src/index.ts` — document `--format html` in help text

### Testing
```bash
# Generate HTML report
npm run build && node dist/index.js --skip-empirical --format html --path /path/to/repo > report.html
open report.html

# Verify it works with empirical data too
npm run build && node dist/index.js --bugs 2 --features 2 --format html --path /path/to/repo > report.html
```

---

## 5. HTML Comparison View

**Goal:** When `--compare` is used with `--format html`, produce a self-contained HTML page showing both repos side-by-side with visual charts.

**Current state:** `--compare` produces markdown or JSON. No visual comparison.

### Design

Extends the HTML report with a split-view layout:

1. **Side-by-side score headers** — Repo A (score, grade) vs Repo B (score, grade)
2. **Overlaid radar charts** — Both repos on the same radar, different colors (blue vs orange)
3. **Category comparison bars** — paired horizontal bars per category, sorted by largest delta
4. **Winner summary** — which repo wins in which categories
5. **Recommendations diff** — what Repo A needs that Repo B already has, and vice versa

### Architecture

Reuse `htmlOutput.ts` chart generators. Add a `generateHtmlComparison()` function that takes two `AnalysisResult` objects.

### Files to modify
- `src/report/htmlOutput.ts` — add `generateHtmlComparison()`
- `src/report/comparison.ts` — add HTML output path
- `src/phases/runner.ts` — route `--compare --format html` to HTML comparison

### Testing
```bash
npm run build && node dist/index.js --skip-empirical --compare /path/to/repo-b --format html --path /path/to/repo-a > comparison.html
open comparison.html
```

---

## 6. Published Benchmarks

**Goal:** Run llm-sense against well-known open-source repos and publish results. Enables direct comparison with Factory.ai's showcased repos.

**Current state:** No published benchmark data.

### Target repos

**Match Factory.ai (their showcased repos):**
1. **CockroachDB** (Go) — large, complex database. Factory.ai rates it Level 4.
2. **FastAPI** (Python) — popular web framework. Factory.ai rates it Level 3.
3. **Express** (JavaScript) — minimal web framework. Factory.ai rates it Level 2.

**Our additions (diverse languages + sizes):**
4. **Next.js** (TypeScript) — large monorepo, React framework
5. **Django** (Python) — large, mature, excellent docs
6. **ripgrep** (Rust) — well-structured CLI tool
7. **Spring Boot** (Java) — enterprise Java framework
8. **Rails** (Ruby) — convention-over-configuration framework

### Deliverables

1. **Benchmark runner script** — `scripts/benchmark.sh` that clones repos, runs `llm-sense --skip-empirical --format json`, collects results
2. **Results JSON** — stored in `benchmarks/results/` with timestamp
3. **Comparison table** — auto-generated markdown table for README/website
4. **Blog post / writeup** — interpret results, compare with Factory.ai's ratings, highlight where llm-sense provides more insight

### Files to create
- New: `scripts/benchmark.sh` — automated benchmark runner
- New: `benchmarks/repos.json` — list of repos to benchmark (name, git URL, language)
- New: `benchmarks/results/` — timestamped result files
- New: `benchmarks/README.md` — auto-generated comparison table

### Automation
- GitHub Action in the llm-sense repo that runs benchmarks weekly or on release tags
- Results committed back to the repo so they're always up to date
- Historical tracking to show how scores change as repos evolve

---

## 7. Deferred: Continuous Learning

**Status:** Skipped for now. claude-reflect (874 stars) is a complementary tool that handles this use case. Revisit if users request it or if claude-reflect becomes unmaintained.

**What it would be:** A mechanism to update CLAUDE.md/.cursorrules automatically when llm-sense detects config drift or when the codebase structure changes significantly.

---

## 8. Deferred: VS Code Extension

**Status:** Deferred entirely. MCP server provides programmatic access. Not in scope for this plan.

**What it would be:** A VS Code sidebar showing per-file/directory LLM-friendliness indicators, overall score, and top recommendations. Separate repo.

---

## Implementation Order

```
Phase A (P0):
  1. Init config formats (30+ tools)     — highest competitive gap

Phase B (P1, can be parallelized):
  2. Expand devInfra                     — completes the readiness pillar coverage
  3. Tree-sitter AST                     — deepest technical improvement
  4. HTML report output                  — most visible to users

Phase C (P1, depends on Phase B):
  5. HTML comparison view                — depends on #4 HTML infrastructure
  6. Published benchmarks                — can start after #2 and #3 improve accuracy
```

## Decision Log

| Question | Decision | Date |
|----------|----------|------|
| Init format count | Match Ruler (30+ tools) | 2026-04-05 |
| AST strategy | Add tree-sitter (web-tree-sitter WASM) | 2026-04-05 |
| HTML report type | Self-contained HTML file | 2026-04-05 |
| New readiness pillars | Expand existing devInfra analyzer | 2026-04-05 |
| Benchmark repos | Match Factory.ai's repos + add 5 more | 2026-04-05 |
| Continuous learning | Skip for now (claude-reflect is complementary) | 2026-04-05 |
| VS Code extension | Defer entirely | 2026-04-05 |
| Multi-repo view | HTML comparison via --compare --format html | 2026-04-05 |
