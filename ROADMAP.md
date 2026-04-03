# llm-sense Strategic Roadmap

> **Goal:** Make llm-sense the definitive tool for measuring and improving codebase LLM-friendliness.
> **Core thesis:** Competitors guess with heuristics. We prove it with empirical testing.

---

## Competitive Context

The "agent readiness" space exploded in early 2026. Key competitors:

| Competitor | Approach | Weakness vs llm-sense |
|------------|----------|----------------------|
| **Factory.ai** | 8 pillars, 5 maturity levels (proprietary SaaS) | Static heuristics only, no empirical testing |
| **@microsoft/agentrc** | 9 pillars, generates AI config files, CI drift detection | Static only, no scoring of actual LLM performance |
| **@aiready/cli** | 0-100 score, offline, no LLM calls | No empirical testing, no CLAUDE.md content scoring |
| **@kodus/agent-readiness** | Open-source Factory.ai clone, 39 checks | No empirical testing, DevOps-focused |
| **agentlinter** | CLAUDE.md linter, 5 dimensions | Config files only, doesn't analyze the codebase |
| **Repomix** (23K stars) | Packs repos for LLM context | Adjacent tool, doesn't analyze or score |

**Our moat:** llm-sense is the only tool that generates synthetic tasks and runs an LLM against the codebase to measure actual success rates. Every competitor relies purely on static analysis.

---

## Design Principles

1. **Prove, don't guess** — Empirical testing is the differentiator. Every feature should reinforce this.
2. **Lean core** — Keep dependencies minimal (currently 4). No tree-sitter, no heavy AST libs. Prefer clever heuristics over heavy deps.
3. **Solo-developer pace** — Every milestone must be shippable by one person. No multi-month epics without intermediate value.
4. **Claude-only** — Deep Claude Code integration is the strength. No multi-model abstraction layer.
5. **Free breakage** — Pre-1.0 semver. Clean architecture over backward compatibility.

---

## Milestones

### Milestone 1: CI/CD Foundation (v0.4.0)

**Theme:** Make llm-sense embeddable in automated pipelines.

This is the highest-priority work because it unlocks team adoption. No team will adopt a tool they can't run in CI.

#### 1.1 Machine-Readable Output

**New flag: `--format <format>`**

| Format | Output | Use Case |
|--------|--------|----------|
| `markdown` (default) | Current report format | Human reading |
| `json` | Full structured JSON to stdout | CI pipelines, dashboards, custom tooling |
| `summary` | One-line score + grade to stdout | Quick checks, shell scripts |

**JSON output schema:**
```typescript
interface LlmSenseJsonOutput {
  version: string;                    // "0.4.0"
  timestamp: string;                  // ISO 8601
  target: string;                     // absolute path analyzed
  score: number;                      // 0-100
  grade: string;                      // A-F
  previousScore: number | null;       // from history, if available
  delta: number | null;               // score change
  categories: Array<{
    name: string;
    score: number;
    weight: number;
    weighted: number;
    findings: string[];
  }>;
  recommendations: Array<{
    id: string;
    title: string;
    priority: 1 | 2 | 3;
    estimatedScoreImpact: number;
    category: string;
  }>;
  empirical: {
    enabled: boolean;
    tasksRun: number;
    tasksSucceeded: number;
    successRate: number;
    avgTurns: number;
    avgCost: number;
    totalCost: number;
  } | null;
  meta: {
    duration: number;                 // total ms
    phaseDurations: Record<string, number>;
    claudeModel: string;
    mode: "full" | "static-only";
  };
}
```

**Implementation:**
- File: `src/report/jsonOutput.ts` — new module, ~100 lines
- Modify `src/phases/runner.ts` to branch on `--format` before calling report generator
- JSON goes to stdout; progress/status messages go to stderr (so `llm-sense --format json > result.json` works cleanly)
- When `--format json`, suppress all chalk output; only emit the JSON blob at the end

#### 1.2 Threshold Exit Codes

**New flag: `--min-score <number>`**

```bash
llm-sense --skip-empirical --format json --min-score 70
# Exit 0 if score >= 70, exit 1 if below
```

**Exit code spec:**
| Code | Meaning |
|------|---------|
| 0 | Success, score meets threshold (or no threshold set) |
| 1 | Score below `--min-score` threshold |
| 2 | Analysis failed (Claude CLI error, path not found, etc.) |

**Implementation:**
- Modify `src/phases/runner.ts` — after scoring, check `options.minScore` and `process.exit()` accordingly
- Add `--min-score` to `src/index.ts` commander options
- Add `minScore` to `CliOptions` in `src/types.ts`

#### 1.3 GitHub Action

**Repository:** `gididaf/llm-sense-action` (separate repo)

```yaml
# .github/workflows/llm-sense.yml
name: LLM-Sense Score
on: [pull_request]

jobs:
  score:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: gididaf/llm-sense-action@v1
        with:
          min-score: 70
          mode: static          # or "full" for empirical
          comment: true         # post PR comment with score
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}  # only needed for mode: full
```

**Action internals:**
- Thin wrapper: installs Node 18, `npx llm-sense`, parses JSON output
- PR comment: uses `actions/github-script` to post/update a comment with score breakdown
- Implements comment deduplication (find existing bot comment, update it instead of creating new)
- Badge: generates a dynamic badge URL using shields.io endpoint

**PR comment format:**
```markdown
## 🔍 LLM-Sense Score: 74/100 (B)

| Category | Score | Δ |
|----------|-------|---|
| Documentation | 82 | +3 |
| File Sizes | 71 | -2 |
| Structure | 68 | — |
| ... | ... | ... |

**Top recommendation:** Add architecture overview to CLAUDE.md (+8 pts estimated)

<details>
<summary>Full report</summary>
[collapsed JSON/markdown details]
</details>
```

#### 1.4 Score Delta Tracking in CI

**Behavior:** When `--format json` and history exists, include `previousScore` and `delta` in output. The GitHub Action uses this to show trend arrows in the PR comment.

**Implementation:**
- History is already tracked in `.llm-sense/history.json`
- JSON output already includes `previousScore` and `delta` from the schema above
- No new code needed beyond 1.1 — this falls out naturally

#### 1.5 Badge Generation

**New flag: `--badge <path>`**

```bash
llm-sense --skip-empirical --badge badge.svg
```

Generates a static SVG badge file (no external service dependency):
```
[llm-sense | 82/100]  (green if >= 80, yellow if >= 60, red if < 60)
```

**Implementation:**
- File: `src/report/badge.ts` — ~50 lines, hardcoded SVG template with color logic
- No dependencies — inline SVG string generation
- Users commit the badge to their repo and reference it in README

---

### Milestone 2: Auto-Fix Mode (v0.5.0)

**Theme:** Close the loop — don't just diagnose, fix.

#### 2.1 Direct Fix Mode

**New flag: `--fix`**

```bash
llm-sense --fix                    # analyze, then apply top recommendation via Claude Code
llm-sense --fix --fix-count 3     # apply top 3 recommendations
llm-sense --fix --fix-id rec-002  # apply a specific recommendation by ID
```

**How it works:**

```
1. Run normal analysis (Phase 1-5, or Phase 1 + 5 if --skip-empirical)
2. Select recommendation(s) to apply
3. For each recommendation:
   a. Create an isolated git worktree (reuse existing isolation infrastructure)
   b. Build a prompt from the recommendation's implementationSteps + context + draftContent
   c. Call Claude Code in agent mode (callClaude()) in the worktree
   d. Run llm-sense --skip-empirical on the worktree to get new score
   e. If score improved: merge worktree changes back to working tree
   f. If score decreased or unchanged: discard, report failure
4. Show before/after score comparison
```

**Safety mechanisms:**
- Always works in a worktree — never modifies the working tree directly until verified
- Shows a diff summary before merging back (unless `--yes` flag is passed)
- Stops on first failure (unless `--fix-continue` is passed)
- Respects `--max-budget-per-task` and `--max-turns-per-task` for cost control
- Requires git repo (cannot fix non-git repos — rsync copies are read-only)

**Implementation:**
- File: `src/phases/autoFix.ts` — new module, ~200 lines
- Reuses `src/core/isolation.ts` for worktree management
- Reuses `src/core/claude.ts` for Claude Code invocation
- Reuses recommendation data structures from `src/report/recommendations.ts`
- Modify `src/phases/runner.ts` to add Phase 7 (auto-fix) after report generation

**Output:**
```
╔══════════════════════════════════════════════════╗
║  Auto-Fix Results                                ║
╠══════════════════════════════════════════════════╣
║  Recommendation: Add CLAUDE.md architecture...   ║
║  Status: ✓ Applied                               ║
║  Score: 68 → 76 (+8)                             ║
║  Files modified: CLAUDE.md                       ║
╚══════════════════════════════════════════════════╝
```

#### 2.2 Fix Dry-Run Mode

**New flag: `--fix --dry-run`**

Runs the fix in a worktree, measures the score delta, but does NOT merge changes back. Useful for previewing impact without committing.

**Implementation:** Skip the merge step in 2.1. Show diff + score delta only.

#### 2.3 Progressive Improvement Plan

**New flag: `--plan`**

```bash
llm-sense --plan
```

Outputs a numbered step-by-step improvement roadmap, ordered by ROI (estimated score impact / effort), with cumulative projected scores:

```markdown
## Improvement Plan for my-project (Current: 62/100)

| Step | Action | Est. Impact | Projected Score |
|------|--------|-------------|-----------------|
| 1 | Create CLAUDE.md with architecture overview | +12 | 74 |
| 2 | Split src/server.ts (1847 lines) into modules | +5 | 79 |
| 3 | Add barrel exports to src/utils/ | +3 | 82 |
| 4 | Remove dead generated files from src/legacy/ | +2 | 84 |

Run `llm-sense --fix --fix-id <step>` to apply any step.
```

**Implementation:**
- File: extend `src/report/recommendations.ts` with a `generatePlan()` function
- Sort recommendations by `estimatedScoreImpact` descending
- Cumulative score is additive estimate (may not be perfectly accurate due to interaction effects — note this in output)

---

### Milestone 3: Static Analysis Upgrades (v0.6.0)

**Theme:** Make `--skip-empirical` mode best-in-class without adding heavy dependencies.

#### 3.1 Cross-File Dependency Graph

**Current state:** `src/analyzers/imports.ts` only tracks `avgImportsPerFile` and `circularDeps`.

**Upgraded analysis:**
- Parse import/require statements with regex (no AST library needed — import syntax is standardized enough)
- Build an adjacency graph: file → [files it imports]
- Compute:
  - **Fan-out score** — avg number of imports per file (high fan-out = hard for LLM to trace)
  - **Fan-in score** — avg number of files that import each file (high fan-in = risky to modify)
  - **Hub files** — files with fan-in > 10 (LLM needs to understand these first)
  - **Orphan files** — files with fan-in = 0 and fan-out = 0 (dead code?)
  - **Circular dependency count** — already exists, keep it
  - **Max dependency chain depth** — longest import chain (deep = hard for LLM context)

**New scoring dimension:** Replace current minimal imports scoring with a "Coupling" category or fold into "Modularity".

**Implementation:**
- File: rewrite `src/analyzers/imports.ts` — ~150 lines
- Regex patterns for: `import ... from '...'`, `require('...')`, `from ... import ...` (Python), `use ...` (Rust)
- Resolve relative paths to build the graph; ignore node_modules/external deps
- No new dependencies — pure regex + path resolution

#### 3.2 Multi-Format AI Config Scoring

**Current state:** Only scores CLAUDE.md across 8 semantic sections.

**Add support for:**
| File | Format | What to score |
|------|--------|---------------|
| `.cursorrules` | Free-form text | Has project context? Has coding conventions? Has file structure hints? |
| `.github/copilot-instructions.md` | Markdown | Same 8-section analysis as CLAUDE.md |
| `AGENTS.md` | Markdown | Same 8-section analysis |
| `.clinerules` | Free-form text | Similar to .cursorrules |
| `.claude/settings.json` | JSON | Has allowed/denied tools? Has custom permissions? |

**Scoring approach:**
- Each config file detected adds points (existence bonus)
- Content quality scored using the same keyword-depth algorithm as CLAUDE.md
- Cross-file consistency check: do different config files agree on conventions?
- New sub-metric: "AI Config Coverage" — what % of major AI tools have config files?

**Implementation:**
- Extend `src/analyzers/documentation.ts` — add `scoreAiConfigFile()` generic function
- Reuse the 8-section keyword analysis with tool-specific keyword adjustments
- Add to documentation category score (increase max points from 100 to account for multi-file bonus)

#### 3.3 Lightweight DevOps Checks

Competitors (Factory.ai, agentrc) score CI/CD, testing, build systems. Add lightweight detection without heavy analysis:

| Check | How to detect | Points |
|-------|--------------|--------|
| Has CI config? | Glob for `.github/workflows/*.yml`, `.gitlab-ci.yml`, `Jenkinsfile` | 5 |
| Has test command? | Check `package.json` scripts.test, `Makefile` test target, `pytest.ini` | 5 |
| Has linter config? | Glob for `.eslintrc*`, `.prettierrc*`, `pyproject.toml [tool.ruff]` | 3 |
| Has pre-commit hooks? | Check `.husky/`, `.pre-commit-config.yaml` | 3 |
| Has type checking? | `tsconfig.json` strict mode, `mypy.ini`, `pyright` config | 4 |

**New scoring category: "Developer Infrastructure"** (replaces or supplements "Context Efficiency")

**Implementation:**
- New file: `src/analyzers/devInfra.ts` — ~80 lines, pure glob/file-existence checks
- Add to `StaticAnalysisResult` in types.ts
- Add scoring function in `scoring.ts`
- Rebalance weights (see weight rebalancing section below)

#### 3.4 Weight Rebalancing

With new categories and improved analyzers, rebalance scoring weights:

**Empirical mode (v0.6.0):**
```
documentation:      0.18  (was 0.20, slightly reduced as AI config scoring adds depth)
taskCompletion:     0.20  (unchanged — still the key differentiator)
fileSizes:          0.12  (was 0.15)
structure:          0.08  (was 0.10)
modularity:         0.10  (unchanged)
contextEfficiency:  0.08  (was 0.10)
tokenEfficiency:    0.10  (unchanged)
naming:             0.04  (was 0.05)
devInfra:           0.05  (NEW)
coupling:           0.05  (NEW — from imports upgrade)
```

**Static-only mode (v0.6.0):**
```
documentation:      0.25  (was 0.28)
fileSizes:          0.17  (was 0.20)
structure:          0.10  (was 0.12)
modularity:         0.13  (was 0.15)
contextEfficiency:  0.13  (was 0.17)
naming:             0.07  (was 0.08)
devInfra:           0.08  (NEW)
coupling:           0.07  (NEW)
```

---

### Milestone 4: Report & Recommendations Overhaul (v0.7.0)

**Theme:** Make reports the best artifact in the space.

#### 4.1 Comparative Reports

**New flag: `--compare <path>`**

```bash
llm-sense --compare /path/to/other-repo
```

Runs analysis on both repos and produces a side-by-side comparison:

```markdown
## Comparison: my-api vs my-frontend

| Category | my-api | my-frontend | Winner |
|----------|--------|-------------|--------|
| Overall | 78 | 64 | my-api |
| Documentation | 85 | 42 | my-api |
| File Sizes | 72 | 81 | my-frontend |
| ... | ... | ... | ... |
```

**Use case:** "Which of our repos should we prioritize for AI tool adoption?"

**Implementation:**
- Run the pipeline twice (sequential to avoid resource contention)
- File: `src/report/comparison.ts` — ~100 lines
- Supports both `--format markdown` and `--format json`

#### 4.2 Historical Trend Report

**New flag: `--trend`**

```bash
llm-sense --trend
```

Reads `.llm-sense/history.json` and produces a trend visualization:

```
Score History for my-project
────────────────────────────
100 │
 90 │
 80 │          ╭──●──●
 70 │     ╭──●─╯
 60 │  ●──╯
 50 │──╯
    └──────────────────────
     Jan  Feb  Mar  Apr
```

**Implementation:**
- File: `src/report/trend.ts` — ~80 lines
- ASCII chart using simple string manipulation (no charting library)
- Also output as JSON array when `--format json`

#### 4.3 Recommendation Quality Improvements

Current recommendations are generated from scoring gaps. Improve them:

- **Specificity:** Instead of "split large files", name the exact files and suggest specific split points based on Phase 2 codebase understanding
- **Draft content:** For CLAUDE.md recommendations, generate a complete draft using Phase 2's `CodebaseUnderstanding` data (architecture, tech stack, conventions, gotchas)
- **Effort estimation:** Add `estimatedEffort: "5min" | "30min" | "2hr" | "half-day"` to each recommendation
- **Dependencies:** Some recommendations depend on others (e.g., "add test command" before "add CI"). Model this with a `dependsOn` field

---

### Milestone 5: DX & Ecosystem Polish (v0.8.0)

**Theme:** Make it delightful to use and easy to adopt.

#### 5.1 Interactive Mode

**New flag: `--interactive` (or just `llm-sense -i`)**

After analysis, drops into an interactive menu:
```
Analysis complete: 72/100 (B-)

What would you like to do?
  [1] View full report
  [2] Apply top recommendation (+12 pts estimated)
  [3] View improvement plan
  [4] Compare with another repo
  [5] Export JSON
  [q] Quit
```

**Implementation:**
- Use Node.js built-in `readline` — no new dependencies
- File: `src/interactive.ts` — ~120 lines

#### 5.2 Watch Mode

**New flag: `--watch`**

```bash
llm-sense --watch --skip-empirical
```

Watches for file changes and re-runs static analysis, showing live score updates. Useful during active development: "I'm improving my CLAUDE.md — show me the score going up in real-time."

**Implementation:**
- Use Node.js built-in `fs.watch` — no new dependencies
- Debounce re-analysis (500ms after last change)
- Only re-run Phase 1 + Phase 5 (static analysis + scoring)
- Show compact one-line output: `[12:34:56] Score: 74/100 (B) — Documentation: 85, Structure: 68...`

#### 5.3 Init Command

**New command: `llm-sense init`**

Scaffolds AI config files for a repo based on quick static analysis:

```bash
llm-sense init
# Analyzes repo, generates:
# - CLAUDE.md (populated with detected architecture, tech stack, patterns)
# - .cursorrules (if Cursor detected)
# - .github/copilot-instructions.md (if GitHub Copilot detected)
```

**Implementation:**
- Run Phase 1 (static analysis) only
- Use detected patterns to populate templates
- File: `src/commands/init.ts` — ~150 lines
- Templates stored as string literals in `src/constants.ts`

---

## Version Plan Summary

| Version | Codename | Key Features | Breaking Changes |
|---------|----------|-------------|------------------|
| **v0.4.0** | Pipeline | `--format json`, `--min-score`, GitHub Action, badges | Output to stderr when `--format json` |
| **v0.5.0** | Healer | `--fix`, `--fix --dry-run`, `--plan` | New Phase 7 in pipeline |
| **v0.6.0** | Analyst | Dependency graph, multi-AI-config scoring, dev infra checks | Scoring weight rebalance, new categories |
| **v0.7.0** | Reporter | `--compare`, `--trend`, better recommendations | Recommendation schema changes |
| **v0.8.0** | Polish | Interactive mode, `--watch`, `llm-sense init` | New subcommand structure |

---

## File Impact Map

New files to create:

```
src/
├── commands/
│   └── init.ts                    # v0.8.0: init command
├── report/
│   ├── jsonOutput.ts              # v0.4.0: JSON formatter
│   ├── badge.ts                   # v0.4.0: SVG badge generator
│   ├── comparison.ts              # v0.7.0: side-by-side report
│   └── trend.ts                   # v0.7.0: historical trend chart
├── analyzers/
│   └── devInfra.ts                # v0.6.0: CI/linter/test detection
├── phases/
│   └── autoFix.ts                 # v0.5.0: auto-fix orchestrator
└── interactive.ts                 # v0.8.0: interactive mode
```

Files to modify:

```
src/index.ts                       # Every milestone: new CLI flags
src/types.ts                       # Every milestone: new types
src/constants.ts                   # v0.6.0: weight rebalance, new constants
src/phases/runner.ts               # v0.4.0: format branching; v0.5.0: Phase 7
src/phases/scoring.ts              # v0.6.0: new categories + weights
src/analyzers/imports.ts           # v0.6.0: dependency graph rewrite
src/analyzers/documentation.ts     # v0.6.0: multi-format AI config scoring
src/report/generator.ts            # v0.7.0: recommendation improvements
src/report/recommendations.ts      # v0.5.0: plan generation; v0.7.0: quality upgrade
```

---

## Implementation Notes

### No New Dependencies Policy

Every feature in this roadmap is achievable with zero new npm dependencies:

| Feature | Approach | Why no library needed |
|---------|----------|----------------------|
| JSON output | `JSON.stringify()` | Built-in |
| SVG badges | Hardcoded SVG template string | ~20 lines of SVG |
| GitHub Action | Shell script + `npx` | Actions are YAML + bash |
| Import graph | Regex on import statements | Import syntax is standardized |
| ASCII trend chart | String manipulation | ~40 lines |
| Interactive mode | `readline` | Built-in Node.js |
| Watch mode | `fs.watch` | Built-in Node.js |
| DevOps detection | `fs.existsSync` + glob | Already have glob via walkDir |

### Testing Strategy

No automated test suite exists yet. For each milestone:

1. Manual testing against the 5 DreamVPS repos (varying sizes)
2. Verify `--format json` output parses correctly with `jq`
3. Test the GitHub Action in a real PR workflow on a test repo
4. For auto-fix: verify worktree isolation never corrupts working tree
5. For scoring changes: compare before/after scores on all 5 repos to validate weight rebalancing

### Risk Mitigations

| Risk | Mitigation |
|------|-----------|
| Auto-fix corrupts working tree | Always operate in worktree; require git repo; show diff before merge |
| Scoring weight changes invalidate historical scores | Store scoring version in history.json; only compare scores from same version |
| GitHub Action exposes API keys | Document that `ANTHROPIC_API_KEY` should be a repo secret; static mode needs no key |
| Import regex misparses edge cases | Target 90% accuracy, not 100%. Unusual import patterns are rare and won't break scoring |
| PR comment bot is noisy | Make `comment: true` opt-in (not default) in GitHub Action config |

---

## Success Metrics

After full roadmap execution, llm-sense should be able to:

- [x] Score any codebase 0-100 with static analysis (exists today)
- [x] Empirically test LLM coding ability on the codebase (exists today)
- [ ] Run in CI and block PRs that degrade LLM-friendliness
- [ ] Auto-fix the top issues and prove the improvement
- [ ] Compare repos side-by-side
- [ ] Show score trends over time
- [ ] Scaffold AI config files for new repos
- [ ] Work interactively for live development feedback

**The end state:** A developer runs `npx llm-sense` on day one, gets a score, runs `llm-sense --fix` to improve it, adds the GitHub Action to their CI, and watches their LLM-friendliness score climb over time. No competitor offers this full loop.
