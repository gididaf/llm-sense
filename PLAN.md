# llm-sense Roadmap: Best-in-Class Sprint

> Goal: Make llm-sense the definitive codebase AI-readiness tool. Beat every competitor on depth, breadth, and developer experience.
>
> Strategy: CLI-first, no cloud, no account. Ship incremental v2.x patches leading to a v3.0 landmark release with VS Code extension and full competitive parity.
>
> Reference: See `COMPETITORS.md` (gitignored) for full competitive intelligence.

---

## Phase 1 — v2.1: Config Audit & Git Intelligence

**Theme:** Close the two biggest analysis gaps that competitors already ship.

### 1.1 `llm-sense audit` subcommand (Config Quality Scoring)
> Competitors: Caliber, Microsoft AgentRC

Score existing AI config files for quality, completeness, and accuracy.

- [x] New subcommand: `llm-sense audit [dir]`
- [x] Detect all AI config files in the repo (CLAUDE.md, .cursorrules, copilot-instructions.md, AGENTS.md, .windsurfrules, etc.)
- [x] Score each config file 0-100 across dimensions:
  - **Completeness** — Does it cover key sections? (project overview, tech stack, patterns, commands, gotchas)
  - **Accuracy** — Do referenced file paths actually exist? Do code blocks match real code?
  - **Freshness** — How stale is the config vs recent git commits? (last modified vs last repo activity)
  - **Consistency** — Do multiple config files agree with each other? (tech stack, commands, conventions)
  - **Specificity** — Is it generic boilerplate or tailored to this codebase? (ratio of project-specific vs generic content)
- [x] Path validation: verify every file path mentioned in configs exists on disk
- [x] Code block validation: verify code snippets in configs match actual source
- [x] Output: console report + `--format json` support
- [x] Actionable recommendations (e.g., "CLAUDE.md references `src/utils/helpers.ts` which doesn't exist")
- [x] Integration with `llm-sense init --detect` to suggest regenerating stale configs

### 1.2 Git-history-aware analysis (`--git-history` flag)
> Competitors: Aider (PageRank), Yek (importance ranking), CodeScene (hotspots), codebase-context MCP

Optional git-based enrichment for Phase 1 static analysis.

- [x] New CLI flag: `--git-history` (off by default, auto-skipped for non-git repos)
- [x] **File importance ranking** — Use git log frequency + recency to rank files by importance (inspired by Aider's PageRank approach). Feed into context window profiling ("these are the files an LLM should see first").
- [x] **Hotspot detection** — Files with high change frequency AND low code health = hotspots. Flag these in recommendations.
- [x] **Convention evolution** — Track naming convention adoption over recent commits (are conventions improving or degrading?)
- [x] **Churn + complexity correlation** — Files that change often AND have high AST complexity are the biggest risk. Surface these explicitly.
- [x] **Knowledge concentration** — Detect bus-factor risk: files touched by only 1 author that are also hub files in the import graph.
- [x] Add git-history findings to the report as a new optional section
- [x] Ensure Phase 1 remains fully functional without git (flag simply adds data, never required)

### 1.3 Minor improvements
- [x] Promote AGENTS.md in `llm-sense init` output (it's the Linux Foundation universal standard, 60K+ repos)
- [x] Add scoring version to JSON output metadata for cross-version comparison (already present since v0.9.0)

---

## Phase 2 — v2.2: GitHub Action & PR Integration

**Theme:** Make llm-sense a first-class CI/CD citizen with CodeRabbit-style PR experience.

### 2.1 Inline PR comments in GitHub Action
> Competitors: CodeRabbit, Qodo, GitHub Copilot Review

Upgrade `gididaf/llm-sense-action` from summary-only to inline + summary.

- [ ] **Summary comment** (enhanced): Score badge, category breakdown table, top 3 recommendations, delta from previous score, grade trend sparkline
- [x] **Inline annotations**: CLI-side `--annotations` flag outputs file-level findings as JSON (god files, naming, security, AST hotspots, hub files)
  - God files (>1000 lines) — annotate the file with "this file has X lines, consider splitting"
  - Naming violations — annotate files that break directory conventions
  - Security findings — annotate files with detected secrets/sensitive patterns
  - AST complexity hotspots — annotate functions with complexity > threshold
  - Import graph issues — annotate hub files with high fan-in/fan-out
- [ ] Use GitHub's `pull_request_review` API for inline comments (not individual issue comments) — **GitHub Action repo**
- [x] Rate limiting: cap at 20 inline comments per PR to avoid noise
- [ ] New action input: `inline-comments: true|false` (default true) — **GitHub Action repo**
- [ ] New action input: `inline-threshold: warning|error` (minimum severity for inline comments) — **GitHub Action repo**
- [ ] Support `--pr-delta` in the action: compare current PR's score against the base branch — **GitHub Action repo**
- [ ] Fail the check if score drops below threshold (existing `min-score` behavior, now with inline context) — **GitHub Action repo**

### 2.2 Dependency graph visualization in HTML reports
> Competitors: CodeRabbit (sequence diagrams), CodeScene (hotspot maps), DeepWiki (architecture diagrams)

Add visual dependency graph to the HTML report output.

- [x] Generate SVG dependency graph from existing import analysis data (fan-in/fan-out, hub files, orphans)
- [x] Use a simple force-directed layout algorithm (no external dependency — implement in inlined JS or pre-compute SVG)
- [x] Color-code nodes: red = hub files (high fan-in), orange = god files, gray = orphans, green = healthy
- [x] Size nodes by line count or importance score
- [x] Highlight circular dependencies with red edges
- [x] Interactive: click a node to see its imports/exports (JS in the self-contained HTML)
- [x] Include in the existing HTML report as a new "Architecture" tab/section
- [x] Keep HTML report self-contained (no external dependencies, inline all JS/CSS)

---

## Phase 3 — v2.3: Enhanced MCP & Token Intelligence

**Theme:** Strengthen our MCP server and context window analysis — areas where we already lead.

### 3.1 MCP server expansion
> Competitors: CodeScene MCP, Augment Code Context Engine, CodePathFinder MCP

Expand the existing 9-tool MCP server with new capabilities.

- [x] New tool: `audit_configs` — run config quality audit via MCP
- [x] New tool: `get_file_importance` — return git-history-based file importance ranking
- [x] New tool: `get_hotspots` — return files with high churn + high complexity
- [x] New tool: `get_dependency_graph` — return import graph as structured JSON
- [x] New tool: `suggest_context` — given a task description, suggest which files an LLM should read (using import graph + file importance + token budget)
- [x] Ensure all new tools work with the existing stdio JSON-RPC implementation

### 3.2 Token compression recommendations
> Competitors: Repomix (70% token reduction via tree-sitter compression)

Add actionable context window optimization advice.

- [x] Analyze which files/directories consume disproportionate tokens vs their importance
- [x] Recommend files to exclude from AI context (generated files, large data files, vendored code)
- [x] Recommend files to summarize/compress (large but important files — suggest extracting types/interfaces only)
- [x] Suggest optimal `.claudeignore` / `.cursorignore` / `.copilotignore` contents based on analysis
- [x] New report section: "Context Window Optimization" with specific ignore-file suggestions
- [x] New flag: `--generate-ignore` to auto-create ignore files for AI tools

### 3.3 Scoring consistency mechanism
> Competitors: Factory.ai (reduced variance from 7% to 0.6%)

Reduce scoring variance for LLM-dependent phases.

- [x] Cache Phase 2 (LLM Understanding) results and use as grounding for subsequent runs
- [ ] Add `--seed` flag for reproducible LLM calls where supported (blocked: Claude CLI doesn't expose seed parameter)
- [x] Track scoring variance in history.json (mode + phase2Cached fields)
- [x] Document expected variance per phase in reports

---

## Phase 4 — v2.4: LLM-Powered Analysis

**Theme:** Go beyond AST/regex with LLM-powered code intelligence.

### 4.1 LLM-powered lint rules
> Competitors: GPTLint (two-pass architecture, Markdown rules)

Add high-level code quality checks that only LLMs can catch.

- [x] New analyzer: `llmLint` in Phase 2c (requires Claude CLI)
- [x] Rules defined in simple Markdown format (user-extensible via `.llm-sense/rules/`)
- [x] Built-in rules:
  - "Functions should do one thing" (single responsibility detection)
  - "Misleading names" (function name doesn't match behavior)
  - "Dead code paths" (unreachable logic that AST can't catch)
  - "Inconsistent error handling patterns" (mixed paradigms)
  - "Missing edge cases" (LLM identifies likely unhandled scenarios)
- [x] Two-pass architecture: Phase 1 AST pre-filters candidates, Phase 2 LLM evaluates (reduces cost)
- [x] Sampling: only lint a stratified sample of files (cap LLM cost)
- [x] Report findings with file:line references and suggested fixes
- [x] New scoring sub-category under Code Quality (errors: -3 pts each cap 15, warnings: -2 pts each cap 10)
- [x] `--no-llm-lint` flag to skip (for cost control)

### 4.2 Multi-LLM provider support for `init`
> Competitors: AgentRules Architect (Anthropic, OpenAI, Google, DeepSeek, xAI)

Allow `llm-sense init` to use different LLM providers for config generation.

- [x] Abstract the Claude CLI call behind a provider interface (`src/core/providers.ts`)
- [x] Support: Claude CLI (default), OpenAI API, Google Gemini API
- [x] New flag: `--provider openai|google|claude` for init command
- [x] Fallback chain: specified provider → Claude CLI → template-based generation
- [x] Keep template-based generation as the zero-dependency fallback

---

## Phase 5 — v3.0: VS Code Extension & Polish

**Theme:** Ship the VS Code extension and reach feature parity with every competitor. Landmark release.

### 5.1 VS Code extension (`llm-sense-vscode`)
> Competitors: AIReady (VS Code extension), CodeScene (IDE extension), Qodo, Sourcery

Full VS Code extension for in-editor AI readiness analysis.

- [ ] **New repository:** `llm-sense-vscode` (separate npm package, published to VS Code Marketplace)
- [ ] **Score overlay:** Run analysis and show the 0-100 score in the status bar. Click to see category breakdown.
- [ ] **Inline diagnostics:** Show warnings/info as VS Code diagnostics (squiggly lines):
  - God files (>1000 lines)
  - High-complexity functions (AST)
  - Naming violations
  - Security findings (secrets)
  - Import graph hub files
- [ ] **File explorer decorations:** Color-code files by health (green/yellow/red) in the file tree
- [ ] **Config audit panel:** Show config quality scores with clickable "fix" actions
- [ ] **Webview report:** Render the full HTML report in a VS Code webview panel
- [ ] **Commands:**
  - `llm-sense: Analyze Workspace` — full analysis
  - `llm-sense: Audit Configs` — config quality check
  - `llm-sense: Generate Config` — run `init` for selected tools
  - `llm-sense: Show Report` — open HTML report in webview
  - `llm-sense: Show Trend` — score history chart
- [ ] **Settings:**
  - `llm-sense.autoAnalyze` — run on workspace open (default: false)
  - `llm-sense.skipEmpirical` — skip LLM phases for fast results (default: true)
  - `llm-sense.scoringProfile` — select scoring profile
- [ ] **Prerequisite:** Requires `llm-sense` CLI installed globally or in workspace
- [ ] **Tech stack:** VS Code Extension API + webview for reports. Calls CLI under the hood.

### 5.2 Enhanced HTML reports (interactive dashboard feel)
> Competitors: Kodus (interactive web dashboard), Factory.ai (org dashboard)

Make the HTML report feel like a dashboard, without needing a server.

- [ ] Add tabbed navigation: Overview | Categories | Architecture | Recommendations | History
- [ ] "Architecture" tab: dependency graph visualization (from Phase 2)
- [ ] "History" tab: interactive score trend chart (not just ASCII — SVG with hover tooltips)
- [ ] "Recommendations" tab: sortable/filterable table with effort, impact, category
- [ ] Dark mode toggle (CSS only, no JS framework)
- [ ] Print-friendly stylesheet for PDF export
- [ ] Keep self-contained: all CSS/JS/SVG inlined, no external deps, target <200KB

### 5.3 Research & benchmarking
> Competitors: CodeScene (published whitepaper linking code health to AI defect rates)

Publish data correlating llm-sense scores with AI task success rates.

- [ ] Run llm-sense against 50+ open-source repos of varying quality
- [ ] For each: run empirical testing (5 bugs + 5 features) and record success rates
- [ ] Correlate llm-sense score with empirical task success rate
- [ ] Publish findings as a blog post / whitepaper: "How Codebase Quality Affects AI Coding Agent Performance"
- [ ] Include data in README and marketing: "Repos scoring 80+ have 3x higher AI task success rates" (or whatever the data shows)
- [ ] Add benchmark results to the repo (`benchmarks/` directory)

---

## Phase 6 — v3.x: Ecosystem & Reach

**Theme:** Extend reach and strengthen the ecosystem.

### 6.1 `llm-sense serve` (local dashboard)
Stay CLI-first but add a local web UI for interactive exploration.

- [ ] `llm-sense serve` starts a local HTTP server (no external deps, use Node's built-in `http` module)
- [ ] Serves the HTML report with live-reload on re-analysis
- [ ] Multi-repo view: analyze multiple repos and compare scores side-by-side
- [ ] History browser: interactive trend charts across all analyzed repos
- [ ] Port defaults to 3838, configurable via `--port`

### 6.2 Org-level aggregation
> Competitors: Factory.ai (organizational dashboard)

- [ ] `llm-sense org` subcommand: scan all repos in a directory (or GitHub org via API)
- [ ] Aggregate scores: mean, median, min, max across repos
- [ ] Identify weakest repos and common organizational patterns
- [ ] Output as JSON + HTML comparison view (reuse existing comparison infrastructure)

### 6.3 Community rule packs
> Competitors: awesome-cursorrules, cursor.directory, agent-rules

- [ ] Support `.llm-sense/rules/` directory for custom analysis rules
- [ ] Publish official rule packs: `@llm-sense/rules-strict`, `@llm-sense/rules-enterprise`
- [ ] Community contribution guide for custom rules
- [ ] Rule packs for LLM lint rules (Phase 4) and scoring profiles

---

## Non-Goals (Decided Against)

| Feature | Reason |
|---------|--------|
| Cloud/SaaS dashboard | Staying CLI-first. Our differentiator is "no account needed." |
| Browser extension | Low impact vs effort. CLI + VS Code extension + GitHub Action cover the main surfaces. |
| Security proxy (like CodeGate) | Out of scope. We detect secrets; we don't intercept AI communications. |
| Local LLM fallback for scoring | Would degrade quality. Claude CLI is the right tool. Template fallback for init is sufficient. |
| Full knowledge graph / semantic index | Too much scope. Import graph + call graph + file importance ranking is enough. |

---

## Success Metrics

| Metric | Target | How to Measure |
|--------|--------|---------------|
| Feature parity with all direct competitors | 100% of P0+P1 gaps closed | Gap checklist in COMPETITORS.md |
| VS Code Marketplace installs | 1K+ in first 3 months | Marketplace analytics |
| npm weekly downloads | 500+ sustained | npm stats |
| GitHub stars | 500+ | GitHub |
| Published benchmark data | 50+ repos analyzed | benchmarks/ directory |
| Config format support | Maintain lead (31+ formats) | Registry count |

---

## Ordering Summary

```
v2.1  Config audit + git-history analysis
v2.2  GitHub Action inline PR comments + dependency graph visualization
v2.3  MCP expansion + token compression recommendations + scoring consistency
v2.4  LLM-powered lint rules + multi-provider init
v3.0  VS Code extension + enhanced HTML reports + published research
v3.x  Local dashboard serve + org aggregation + community rule packs
```

Each phase builds on the previous. Phases 1-4 are incremental CLI improvements. Phase 5 is the big v3.0 launch. Phase 6 is ecosystem expansion post-launch.
