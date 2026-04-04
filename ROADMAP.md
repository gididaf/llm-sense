# llm-sense Roadmap

> **Goal:** The undisputed best tool for measuring and improving codebase LLM-friendliness.
> **Core thesis:** Competitors guess with heuristics. We prove it with empirical testing.

---

## Shipped (v0.3.0–v1.3.0)

<details>
<summary>All shipped features (click to expand)</summary>

| Feature | Version |
|---------|---------|
| 7-phase pipeline (static + LLM understanding + tasks + empirical + scoring + report + auto-fix) | v0.3.0 |
| 10 static analyzers (fileSizes, structure, naming, documentation, imports, modularity, noise, devInfra, security, duplicates) | v0.3.0–v1.0.0 |
| `--format json/summary`, `--min-score`, exit codes | v0.4.0 |
| SVG badge generation (`--badge`) | v0.4.0 |
| Score history tracking + delta display | v0.4.0 |
| `--fix` auto-fix mode (worktree isolation, re-scoring, patch merge) | v0.5.0 |
| `--plan` improvement roadmap | v0.5.0 |
| Coupling analyzer (dependency graph, fan-in/out, hub files, chain depth) | v0.6.0 |
| DevInfra analyzer (CI, tests, linting, pre-commit, type checking) | v0.6.0 |
| 11-category scoring with rebalanced weights | v0.6.0 |
| `--compare` repo comparison | v0.7.0 |
| `--trend` ASCII historical trend chart | v0.7.0 |
| Recommendation effort estimates + dependency ordering | v0.7.0 |
| `--interactive` post-analysis menu | v0.8.0 |
| `--watch` live re-scoring on file changes | v0.8.0 |
| `llm-sense init` — multi-tool config scaffolding (CLAUDE.md, .cursorrules, copilot-instructions, AGENTS.md) | v0.8.0 |
| Config drift detection (stale path/command references in config files) | v0.9.0 |
| Token budget heatmap (per-directory token consumption) | v0.9.0 |
| Security scoring (secrets, .env, .gitignore, sensitive files, lockfiles) | v0.9.0 |
| Deeper AI config file content scoring | v0.9.0 |
| MCP server mode (`llm-sense serve` — 5 tools over JSON-RPC) | v0.10.0 |
| Monorepo support (per-package analysis + aggregate score) | v0.10.0 |
| Semantic duplicate detection (Jaccard similarity on exports) | v1.0.0 |
| Context fragmentation scoring (connected components, cross-cluster ratio) | v1.0.0 |
| LLM-verified scoring (Phase 2b — Claude validates static findings, ±15 adjustment) | v1.0.0 |
| Incremental analysis cache (mtime manifest, version-aware) | v1.0.0 |
| Published GitHub Action (`gididaf/llm-sense-action`) | v1.1.0 |
| Per-PR delta prediction (`--pr-delta`) | v1.1.0 |
| npm publish automation (`.github/workflows/publish.yml`) | v1.1.0 |
| AI-generated config files (`llm-sense init` with Claude-powered generation) | v1.2.0 |
| Auto-improve loop (`--auto-improve --target <score>`) | v1.2.0 |
| Context window profiling (32K/100K/200K/1M tier coverage) | v1.2.0 |
| Language-specific analyzers (TS/JS, Python, Go, Rust, Java/Kotlin, Ruby, PHP, Swift) | v1.3.0 |
| New "Code Quality" scoring category (12 total categories) | v1.3.0 |
| Custom scoring profiles (`--profile strict/docs/security` + `.llm-sense/profile.json`) | v1.3.0 |
| 4 new MCP tools (`get_context_profile`, `get_language_checks`, `auto_improve`, `generate_config`) | v1.3.0 |

</details>

**Current state:** v1.3.0 — matches or beats every competitor on static analysis, plus empirical testing, AI-generated configs, auto-improve loop, and context window profiling nobody else offers.

---

## Competitive Position (April 2026)

| Us | Them | Verdict |
|----|------|---------|
| 11 scoring categories + empirical testing | Factory.ai: 8 pillars, static only | We win |
| Config drift + deep content scoring | @rely-ai/caliber: drift detection only | We win |
| MCP server (5 tools) | CodeScene MCP (code health only) | We win |
| Monorepo per-package scoring | Factory.ai, Kodus: monorepo support | Parity |
| Security scoring (5 checks) | Factory.ai, Kodus: security pillar | Parity |
| Multi-tool init (4 config files) | agentrc: generates configs + CI drift | Parity |
| Published GitHub Action | agentrc, Kodus: CI integration | **Parity** |
| AI-generated configs via Claude | agentrc: generates real content | **We win** |
| No IDE extension | agentrc: VS Code extension | **They win** |
| Per-PR delta prediction (`--pr-delta`) | — | **We win** (nobody else) |
| Language-specific checks (8 languages) | — | **We win** |
| Context window profiling | — | **We win** (unique) |
| Auto-improve loop | — | **We win** (unique) |

**What we need:** IDE extension (VS Code) is the only remaining gap.

---

## Design Principles (Unchanged)

1. **Prove, don't guess** — Empirical testing is the differentiator
2. **Lean core** — 4 npm dependencies (chalk, commander, zod, zod-to-json-schema). No new deps.
3. **Solo-developer pace** — Every milestone shippable by one person
4. **Claude-only** — Deep Claude Code integration, no multi-model abstraction
5. **Free breakage** — Pre-2.0 semver allows breaking changes

---

## Milestone 9: Distribution (v1.1.0) ✅ SHIPPED

**Theme:** Put llm-sense where developers already are. The best tool nobody uses loses to a worse tool everyone uses.

### 9.1 Published GitHub Action

The #1 adoption blocker for teams. We have JSON output, exit codes, and history — the Action is just a wrapper.

**Repository:** `gididaf/llm-sense-action`

#### action.yml

```yaml
name: 'LLM-Sense Score'
description: 'Analyze codebase LLM-friendliness. Score 0-100 with category breakdown.'
author: 'gididaf'

branding:
  icon: 'cpu'
  color: 'blue'

inputs:
  mode:
    description: 'Analysis mode: "static" (fast, free, no API key) or "full" (empirical testing, requires ANTHROPIC_API_KEY)'
    required: false
    default: 'static'
  min-score:
    description: 'Minimum passing score (0-100). Check fails if score is below this threshold.'
    required: false
    default: '0'
  comment:
    description: 'Post/update a PR comment with score breakdown. Only works on pull_request events.'
    required: false
    default: 'true'
  badge:
    description: 'Generate and commit an SVG badge file at this path (e.g., "llm-sense-badge.svg").'
    required: false
    default: ''
  path:
    description: 'Path to analyze relative to repository root.'
    required: false
    default: '.'
  extra-args:
    description: 'Additional CLI flags passed through to llm-sense (e.g., "--bugs 3 --features 3").'
    required: false
    default: ''

outputs:
  score:
    description: 'The overall LLM-friendliness score (0-100)'
  grade:
    description: 'Letter grade (A-F)'
  delta:
    description: 'Score change from previous run (null if first run)'
  json:
    description: 'Full JSON output from llm-sense'

runs:
  using: 'composite'
  steps:
    - name: Setup Node.js
      uses: actions/setup-node@v4
      with:
        node-version: '18'

    - name: Run llm-sense
      id: analyze
      shell: bash
      run: |
        MODE_FLAG=""
        if [ "${{ inputs.mode }}" = "static" ]; then
          MODE_FLAG="--skip-empirical"
        fi

        BADGE_FLAG=""
        if [ -n "${{ inputs.badge }}" ]; then
          BADGE_FLAG="--badge ${{ inputs.badge }}"
        fi

        npx llm-sense@latest \
          --format json \
          --min-score ${{ inputs.min-score }} \
          --path ${{ inputs.path }} \
          $MODE_FLAG \
          $BADGE_FLAG \
          ${{ inputs.extra-args }} \
          > /tmp/llm-sense-result.json 2>/tmp/llm-sense-stderr.log || true

        # Parse outputs
        SCORE=$(jq -r '.score' /tmp/llm-sense-result.json 2>/dev/null || echo "0")
        GRADE=$(jq -r '.grade' /tmp/llm-sense-result.json 2>/dev/null || echo "F")
        DELTA=$(jq -r '.delta // empty' /tmp/llm-sense-result.json 2>/dev/null || echo "")

        echo "score=$SCORE" >> "$GITHUB_OUTPUT"
        echo "grade=$GRADE" >> "$GITHUB_OUTPUT"
        echo "delta=$DELTA" >> "$GITHUB_OUTPUT"
        echo "json=$(cat /tmp/llm-sense-result.json)" >> "$GITHUB_OUTPUT"

        # Enforce min-score threshold
        if [ "$SCORE" -lt "${{ inputs.min-score }}" ] 2>/dev/null; then
          echo "::error::LLM-Sense score $SCORE is below minimum threshold ${{ inputs.min-score }}"
          exit 1
        fi

    - name: Post PR comment
      if: inputs.comment == 'true' && github.event_name == 'pull_request'
      uses: actions/github-script@v7
      with:
        script: |
          const fs = require('fs');
          let result;
          try {
            result = JSON.parse(fs.readFileSync('/tmp/llm-sense-result.json', 'utf8'));
          } catch (e) {
            core.warning('Failed to parse llm-sense output, skipping PR comment');
            return;
          }

          const deltaStr = result.delta != null
            ? (result.delta > 0 ? ` (+${result.delta})` : result.delta < 0 ? ` (${result.delta})` : ' (unchanged)')
            : '';

          const gradeEmoji = { A: '🟢', B: '🔵', C: '🟡', D: '🟠', F: '🔴' }[result.grade] || '⚪';

          const categories = (result.categories || [])
            .sort((a, b) => b.weight - a.weight)
            .map(c => `| ${c.name} | ${c.score} | ${Math.round(c.weight * 100)}% |`)
            .join('\n');

          const topRec = result.recommendations?.[0];
          const recLine = topRec
            ? `\n**Top recommendation:** ${topRec.title} (+${topRec.estimatedScoreImpact} pts est.)`
            : '';

          const body = [
            `## ${gradeEmoji} LLM-Sense: ${result.score}/100 (${result.grade})${deltaStr}`,
            '',
            '| Category | Score | Weight |',
            '|----------|-------|--------|',
            categories,
            recLine,
            '',
            '<details><summary>Full JSON</summary>',
            '',
            '```json',
            JSON.stringify(result, null, 2),
            '```',
            '',
            '</details>',
            '',
            `*Mode: ${result.meta?.mode || 'unknown'} | Duration: ${Math.round((result.meta?.duration || 0) / 1000)}s*`,
          ].join('\n');

          // Find existing comment to update
          const MARKER = '## ';
          const { data: comments } = await github.rest.issues.listComments({
            owner: context.repo.owner,
            repo: context.repo.repo,
            issue_number: context.issue.number,
          });
          const existing = comments.find(c =>
            c.body?.includes('LLM-Sense:') && c.user?.login === 'github-actions[bot]'
          );

          if (existing) {
            await github.rest.issues.updateComment({
              owner: context.repo.owner,
              repo: context.repo.repo,
              comment_id: existing.id,
              body,
            });
          } else {
            await github.rest.issues.createComment({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: context.issue.number,
              body,
            });
          }

    - name: Commit badge
      if: inputs.badge != '' && github.event_name == 'pull_request'
      shell: bash
      run: |
        if [ -f "${{ inputs.badge }}" ]; then
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add "${{ inputs.badge }}"
          git diff --cached --quiet || git commit -m "Update llm-sense badge [skip ci]"
          git push
        fi
```

#### Usage examples for Action README

```yaml
# Minimal — static analysis on every PR
name: LLM-Sense
on: [pull_request]
jobs:
  score:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: gididaf/llm-sense-action@v1
```

```yaml
# Strict — fail PR if score drops below 70
name: LLM-Sense Quality Gate
on: [pull_request]
jobs:
  score:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: gididaf/llm-sense-action@v1
        with:
          min-score: 70
          comment: true
```

```yaml
# Full — empirical testing with badge
name: LLM-Sense Full
on:
  push:
    branches: [main]
jobs:
  score:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: gididaf/llm-sense-action@v1
        with:
          mode: full
          badge: llm-sense-badge.svg
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

#### Deliverables

```
gididaf/llm-sense-action/
├── action.yml           # Composite action (above)
├── README.md            # Usage docs, examples, badge setup
├── LICENSE              # MIT
└── .github/
    └── workflows/
        └── test.yml     # Self-test: runs action on this repo
```

---

### 9.2 Per-PR Delta Prediction

**What:** When running in CI, analyze only files changed in the PR and predict the score impact — without running full analysis. Makes the GitHub Action response time <5 seconds even on large repos.

**Why:** Full static analysis takes 300ms–3s. In CI, developers want fast feedback. Predicting "this PR will change your score by approximately -2 points (documentation category)" is more useful than waiting for a full re-run.

**How it works:**

1. Get list of changed files: `git diff --name-only HEAD~1` (or compare against base branch)
2. Classify each changed file by which scoring categories it affects:
   - `CLAUDE.md` / config files changed → affects Documentation
   - Source files added/removed → affects File Sizes, Structure, Modularity
   - Import statements changed → affects Coupling
   - `.github/workflows/` changed → affects DevInfra
   - `.gitignore` / `.env` changed → affects Security
3. For affected categories only, re-run just those analyzers on the full codebase (leveraging cache for unaffected categories)
4. Compute new category scores, compare with cached previous scores
5. Output predicted delta per category + overall

**New flag: `--pr-delta`**

```bash
llm-sense --pr-delta --format json
# Output: { "predictedDelta": -2, "affectedCategories": ["documentation", "fileSizes"], ... }
```

**Implementation:**
- New function `predictPrDelta()` in `src/phases/runner.ts` (~60 lines)
- Reuses `git.ts` for diff detection
- Reuses `cache.ts` for loading previous results
- Reuses individual analyzers selectively
- New `PrDeltaResult` type in `src/types.ts`
- Add `--pr-delta` to `CliOptions` and `src/index.ts`
- Integrate into GitHub Action: when `--pr-delta` is available and cache exists, use it for the PR comment body; fall back to full analysis otherwise

**Performance target:** <2 seconds for any repo size (only re-analyzes affected categories)

---

### 9.3 npm Publishing Automation

**What:** Ensure `npx llm-sense` works seamlessly. Set up GitHub Actions CI for the main repo to auto-publish on version tag.

**Implementation:**

```yaml
# .github/workflows/publish.yml
name: Publish to npm
on:
  push:
    tags: ['v*']
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '18'
          registry-url: 'https://registry.npmjs.org'
      - run: npm ci && npm run build
      - run: npm publish
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

**Also:**
- Add `"files": ["dist"]` to package.json if not present (ships only built output)
- Verify `"bin": { "llm-sense": "dist/index.js" }` has shebang in tsup output
- Add `engines` field: `{ "node": ">=18" }`
- Test `npx llm-sense --skip-empirical --path .` from a clean environment

---

## Milestone 10: Intelligence (v1.2.0) ✅ SHIPPED

**Theme:** Use Claude to do things static analysis never can. This is the unfair advantage.

### 10.1 AI-Generated Config Files

**What:** Replace template-based `init` with Claude-powered generation that reads the codebase and writes real, substantive config files. Not templates with TODOs — actual architecture descriptions, real gotchas, real patterns.

**Why:** This is the highest-value feature we can add. agentrc generates configs but using static heuristics. We have Claude. A CLAUDE.md written by Claude after reading your codebase is 10x more useful than a template.

**Current state:** `src/commands/init.ts` has 4 generator functions (`generateClaudeMdFromStatic()`, `generateCursorRules()`, `generateCopilotInstructions()`, `generateAgentsMd()`) that use string concatenation with detected tech stack and placeholder TODOs.

**New behavior:** When Claude CLI is available, use `callClaudeStructured()` to generate each file with real content. Template-based generation remains as fallback when Claude is not installed.

**Implementation — new function `generateClaudeMdWithClaude()`:**

```typescript
// src/commands/init.ts — new function (~80 lines)

async function generateClaudeMdWithClaude(
  targetPath: string,
  staticResult: StaticAnalysisResult,
  techStack: string[],
  frameworks: string[],
  commands: DetectedCommands,
): Promise<string> {
  // Build context from static analysis
  const tree = await buildDirectorySummary(targetPath);
  const sampleFiles = await stratifiedSample(targetPath, 30);
  const sampleContents = await Promise.all(
    sampleFiles.map(async f => ({
      path: f.relativePath,
      content: await readFileSafe(f.absolutePath, 200), // first 200 lines
    }))
  );

  const prompt = `You are analyzing a codebase to generate a comprehensive CLAUDE.md file.

## Codebase Context
- Tech stack: ${techStack.join(', ')}
- Frameworks: ${frameworks.join(', ')}
- Commands: build=${commands.build || 'unknown'}, test=${commands.test || 'unknown'}, dev=${commands.dev || 'unknown'}
- File count: ${staticResult.fileSizes.totalFiles}
- Directory structure:
${tree}

## Sample Files (30 representative files):
${sampleContents.map(f => `### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``).join('\n\n')}

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

  const schema = z.object({
    architectureOverview: z.string(),
    moduleMap: z.string(),
    commonPatterns: z.string(),
    testing: z.string(),
    buildRunDeploy: z.string(),
    gotchas: z.string(),
    techStack: z.string(),
    environmentSetup: z.string(),
  });

  const { data } = await callClaudeStructured(
    { prompt, cwd: targetPath, timeout: 120_000 },
    schema,
  );

  return [
    `# ${path.basename(targetPath)}`,
    '',
    '## Architecture Overview',
    '', data.architectureOverview, '',
    '## Module Map',
    '', data.moduleMap, '',
    '## Common Patterns',
    '', data.commonPatterns, '',
    '## Testing',
    '', data.testing, '',
    '## Build / Run / Deploy',
    '', data.buildRunDeploy, '',
    '## Gotchas',
    '', data.gotchas, '',
    '## Tech Stack',
    '', data.techStack, '',
    '## Environment Setup',
    '', data.environmentSetup, '',
  ].join('\n');
}
```

**Same pattern for .cursorrules, copilot-instructions.md, AGENTS.md** — each gets its own Claude prompt tailored to the tool's conventions and format.

**Integration into init flow:**

```typescript
// src/commands/init.ts — modify runInit()

const claudeAvailable = await isClaudeInstalled();

if (claudeAvailable) {
  log(chalk.cyan('Claude CLI detected — generating AI-powered config files...'));
  claudeMdContent = await generateClaudeMdWithClaude(targetPath, staticResult, techStack, frameworks, commands);
  cursorContent = await generateCursorRulesWithClaude(targetPath, staticResult, techStack);
  // ...
} else {
  log(chalk.yellow('Claude CLI not found — using template-based generation (add Claude for richer output)'));
  claudeMdContent = generateClaudeMdFromStatic(staticResult, techStack, frameworks, commands);
  cursorContent = generateCursorRules(techStack, frameworks, commands);
  // ...
}
```

**Cost:** ~$0.05–0.15 per file (single structured Claude call with 30 sampled files). Total init cost: ~$0.20–0.60.

**Files modified:**
- `src/commands/init.ts` — add AI generation functions, modify `runInit()` flow
- `src/types.ts` — add `ClaudeMdSections` Zod schema

---

### 10.2 Auto-Improve Loop

**What:** `llm-sense --auto-improve --target 85` — keep running `--fix` in a loop until the target score is reached or no more improvements are possible.

**Why:** Magical UX. "Make my codebase score 85 and tell me when you're done." Wraps existing `--fix` infrastructure with a convergence loop.

**New flags:**
```
--auto-improve              Enable auto-improvement loop
--target <score>            Target score to reach (required with --auto-improve)
--max-iterations <n>        Max fix cycles (default: 10)
--max-total-budget <usd>    Total budget cap across all iterations (default: 5.00)
```

**Algorithm:**

```
currentScore = runAnalysis()
iteration = 0
totalCost = 0

while currentScore < target AND iteration < maxIterations AND totalCost < maxTotalBudget:
    recommendations = getRecommendations().filter(r => r.estimatedScoreImpact > 0)

    if recommendations.length == 0:
        log("No more improvements available")
        break

    # Pick top recommendation by ROI (impact / effort)
    topRec = recommendations[0]

    result = runAutoFix(topRec)
    totalCost += result.costUsd

    if not result.success:
        log("Fix failed: ${result.error}, trying next recommendation")
        # Skip this rec, try next one
        continue

    currentScore = result.scoreAfter
    iteration++

    log("Iteration ${iteration}: ${result.scoreBefore} → ${result.scoreAfter} (+${result.delta})")

log("Auto-improve complete: ${startScore} → ${currentScore} in ${iteration} iterations ($${totalCost})")
```

**Implementation:**
- New function `runAutoImprove()` in `src/phases/autoFix.ts` (~80 lines)
- Wraps existing `runAutoFix()` in a loop
- Tracks cumulative cost, iteration count, failed recommendations (to skip)
- Outputs summary table at end:

```
Auto-Improve Results
─────────────────────────────────────────────────────
Start: 62/100 (C)  →  Target: 85  →  Reached: 81/100 (B)

| # | Recommendation | Delta | Cost |
|---|---------------|-------|------|
| 1 | Add CLAUDE.md architecture overview | +12 | $0.08 |
| 2 | Split src/server.ts into modules | +4 | $0.32 |
| 3 | Add barrel exports to src/utils/ | +2 | $0.05 |
| 4 | Fix 3 stale references in CLAUDE.md | +1 | $0.03 |

Total: +19 points in 4 iterations ($0.48)
Remaining gap to target: 4 points (no more high-ROI improvements found)
```

**Safety:**
- Respects `--max-total-budget` hard cap
- Each iteration uses worktree isolation (existing behavior)
- Never applies a fix that decreases the score (existing behavior)
- `--dry-run` mode: run the loop, show what would happen, don't merge anything
- Skips recommendations that failed in previous iterations (prevents infinite retry)

**Files modified:**
- `src/phases/autoFix.ts` — add `runAutoImprove()`
- `src/index.ts` — add `--auto-improve`, `--target`, `--max-iterations`, `--max-total-budget`
- `src/types.ts` — add fields to `CliOptions`
- `src/phases/runner.ts` — add auto-improve path (Phase 7b)

---

### 10.3 Context Window Profiling

**What:** Estimate how much of the codebase fits in various LLM context windows and recommend which model tier is needed for effective work.

**Why:** No competitor does this. It's a unique, immediately actionable insight: "Your repo needs a 200K+ token model. Haiku won't work, Sonnet barely fits, Opus with 1M context can hold the entire codebase."

**New section in report output:**

```
Context Window Profile
─────────────────────────────────────────────────
Total source tokens (estimated): ~245,000

| Context Window | Coverage | Verdict |
|----------------|----------|---------|
| 32K tokens     | 13%      | Insufficient — only small files |
| 100K tokens    | 41%      | Partial — core modules fit |
| 200K tokens    | 82%      | Good — most source code fits |
| 1M tokens      | 100%     | Full — entire codebase fits |

Recommended minimum: 200K context window
Best experience: 1M context window (Claude Opus)

Top context consumers:
  src/components/  28% (68,200 tokens)
  src/services/    15% (36,800 tokens)
  src/utils/       10% (24,200 tokens)
```

**Implementation:**
- New function `buildContextWindowProfile()` in `src/core/fs.ts` (~50 lines)
- Reuses `buildTokenHeatmap()` for token counts
- Computes cumulative coverage at each window size
- Window tiers: 32K, 100K, 200K, 1M
- Verdict logic: <50% = "Insufficient", 50-80% = "Partial", 80-95% = "Good", 95%+ = "Full"
- Recommendation: smallest tier with "Good" or better verdict

**Add to report:**
- New section in `src/report/generator.ts` — always shown (not behind `--verbose`)
- Include in JSON output as `contextProfile` field

**Add to MCP server:**
- New tool `get_context_profile` in `src/mcp/server.ts`
- Returns window tiers with coverage percentages

**Files modified:**
- `src/core/fs.ts` — add `buildContextWindowProfile()`
- `src/types.ts` — add `ContextWindowProfile` type
- `src/report/generator.ts` — add context profile section
- `src/report/jsonOutput.ts` — add to JSON schema
- `src/mcp/server.ts` — add `get_context_profile` tool
- `src/phases/staticAnalysis.ts` — call `buildContextWindowProfile()` and store result

---

## Milestone 11: Language Intelligence (v1.3.0) ✅ SHIPPED

**Theme:** Go deeper than file-level heuristics. Understand language-specific patterns that affect LLM effectiveness — without tree-sitter.

### 11.1 Language-Specific Analyzers

**What:** Regex-based checks for language-specific patterns that make code harder for LLMs to work with. Each language gets a set of checks that produce findings and affect the score.

**New file: `src/analyzers/languageChecks.ts`**

#### TypeScript/JavaScript Checks

| Check | Regex Pattern | Impact |
|-------|--------------|--------|
| `any` type usage | `:\s*any[\s;,\)\]]` | -1 pt per occurrence (cap -10). LLMs propagate `any` instead of inferring types |
| Strict mode disabled | `tsconfig.json` missing `"strict": true` | -5 pts. Loose types = LLMs write looser code |
| Barrel re-exports without docs | `export \* from` in index.ts without comment | Finding only. LLMs can't navigate opaque re-exports |
| Dynamic imports | `import\(` (non-static) | Finding only. LLMs can't statically trace dependencies |
| Implicit return types | `(async\s+)?function\s+\w+\([^)]*\)\s*\{` without `: ReturnType` | Finding only. Explicit types help LLMs understand contracts |

#### Python Checks

| Check | Regex Pattern | Impact |
|-------|--------------|--------|
| Missing type hints | `def \w+\([^:)]+\)` (params without `:`) | -1 pt per function (cap -10). Type hints are critical for LLM understanding |
| No docstrings on public functions | `def [a-z]\w+\(` not preceded by `"""` | Finding only. Docstrings guide LLM behavior |
| Wildcard imports | `from \w+ import \*` | -2 pts per occurrence (cap -8). LLMs can't resolve what's imported |
| Missing `__init__.py` in package dirs | Directory with .py files but no `__init__.py` | Finding only. Breaks LLM's module resolution assumptions |

#### Go Checks

| Check | Regex Pattern | Impact |
|-------|--------------|--------|
| Ignored errors | `[^_]\s*,\s*_\s*[:=]+.*\(` or `\w+\([^)]*\)\s*$` (no error capture) | -1 pt per occurrence (cap -10). LLMs copy error-ignoring patterns |
| No comments on exported functions | `^func [A-Z]` not preceded by `//` | Finding only. Go convention that LLMs respect |
| Interface pollution | >10 methods in an interface | Finding only. Large interfaces are hard for LLMs to implement correctly |

#### Rust Checks

| Check | Regex Pattern | Impact |
|-------|--------------|--------|
| Excessive `unwrap()` | `\.unwrap\(\)` | -1 pt per occurrence (cap -10). LLMs copy unsafe unwrap patterns |
| Missing doc comments on public items | `pub (fn\|struct\|enum\|trait)` not preceded by `///` | Finding only |
| Unsafe blocks | `unsafe\s*\{` | Finding only. LLMs shouldn't generate unsafe code without guidance |

#### Java/Kotlin Checks

| Check | Regex Pattern | Impact |
|-------|--------------|--------|
| Raw types (Java) | `List\s` or `Map\s` without `<` | -1 pt per occurrence (cap -10) |
| Missing Javadoc on public methods | `public .* \w+\(` not preceded by `/**` | Finding only |

#### Ruby Checks

| Check | Regex Pattern | Impact |
|-------|--------------|--------|
| Monkey patching | `class (String\|Array\|Hash\|Integer\|Object)` | Finding only. LLMs can't predict monkey-patched behavior |
| Missing YARD docs | `def \w+` not preceded by `# @` | Finding only |

#### PHP Checks

| Check | Regex Pattern | Impact |
|-------|--------------|--------|
| Missing type declarations | `function \w+\(.*\$\w+[^:]` | Finding only |
| `eval()` usage | `\beval\s*\(` | -3 pts per occurrence (cap -9). Security risk + LLMs can generate eval |

#### C#/Swift Checks

| Check | Regex Pattern | Impact |
|-------|--------------|--------|
| Force unwrap (Swift) | `\w+!\.` or `as!` | -1 pt per occurrence (cap -10) |
| Missing XML docs (C#) | `public .* \w+\(` not preceded by `///` | Finding only |

**Implementation approach:**
- New file: `src/analyzers/languageChecks.ts` (~250 lines)
- Detect primary language from file extension distribution (reuse existing detection)
- Run only checks for detected languages
- Sample up to 100 files per language (use `stratifiedSample()`)
- Read first 500 lines of each file (avoid reading giant files fully)
- Return `LanguageCheckResult`: `{ language: string, checks: Check[], totalPenalty: number, findings: string[] }`

**Scoring integration:**
- New sub-score within "Naming" category (rename to "Code Quality" or keep as-is and fold language checks into recommendations only)
- Alternative: create new "Type Safety" category with small weight (3-4%)
- Language penalty applied as: `max(0, baseNamingScore - totalPenalty)`

**Files modified:**
- New file: `src/analyzers/languageChecks.ts`
- `src/types.ts` — add `LanguageCheckResult` type
- `src/phases/staticAnalysis.ts` — call `runLanguageChecks()`
- `src/phases/scoring.ts` — integrate language penalty into scoring
- `src/report/generator.ts` — add language checks section to report
- `src/report/recommendations.ts` — generate language-specific recommendations

---

### 11.2 Custom Scoring Profiles

**What:** Let teams define their own category weights. An ML team might weight documentation higher. A startup iterating fast might care less about naming.

**New flag: `--profile <name|path>`**

**Built-in profiles:**

```typescript
// src/constants.ts additions

const SCORING_PROFILES: Record<string, Record<string, number>> = {
  default: SCORING_WEIGHTS,                    // current weights
  'static-only': SCORING_WEIGHTS_NO_EMPIRICAL, // current no-empirical weights

  strict: {
    // For teams that want the highest bar
    documentation: 0.20,
    taskCompletion: 0.15,
    fileSizes: 0.10,
    structure: 0.08,
    modularity: 0.10,
    contextEfficiency: 0.07,
    tokenEfficiency: 0.08,
    naming: 0.05,
    devInfra: 0.05,
    coupling: 0.05,
    security: 0.07,
  },

  docs: {
    // Documentation-heavy — for teams prioritizing AI onboarding
    documentation: 0.35,
    taskCompletion: 0.15,
    fileSizes: 0.08,
    structure: 0.05,
    modularity: 0.07,
    contextEfficiency: 0.05,
    tokenEfficiency: 0.08,
    naming: 0.03,
    devInfra: 0.04,
    coupling: 0.04,
    security: 0.06,
  },

  security: {
    // Security-focused — for regulated industries
    documentation: 0.12,
    taskCompletion: 0.12,
    fileSizes: 0.08,
    structure: 0.06,
    modularity: 0.08,
    contextEfficiency: 0.06,
    tokenEfficiency: 0.08,
    naming: 0.04,
    devInfra: 0.06,
    coupling: 0.05,
    security: 0.25,
  },
};
```

**Custom profiles via file:**

```json
// .llm-sense/profile.json
{
  "name": "my-team",
  "weights": {
    "documentation": 0.30,
    "taskCompletion": 0.15,
    "fileSizes": 0.10,
    "structure": 0.05,
    "modularity": 0.10,
    "contextEfficiency": 0.05,
    "tokenEfficiency": 0.08,
    "naming": 0.03,
    "devInfra": 0.06,
    "coupling": 0.03,
    "security": 0.05
  }
}
```

**Implementation:**
- Add profile loading to `src/phases/scoring.ts` (~30 lines)
- `--profile my-team` → look for `.llm-sense/profile.json`, validate weights sum to 1.0
- `--profile strict` → use built-in profile
- Fall back to `default` or `static-only` based on mode
- Store profile name in `HistoryEntry` for trend comparison
- Warn in `--trend` if comparing scores from different profiles

**Files modified:**
- `src/constants.ts` — add `SCORING_PROFILES`
- `src/phases/scoring.ts` — accept profile parameter in `computeScores()`
- `src/index.ts` — add `--profile` flag
- `src/types.ts` — add `profile` to `CliOptions`
- `src/core/history.ts` — store profile in history entries

---

### 11.3 New MCP Tools

Extend the MCP server with intelligence from v1.2 and v1.3 features:

| Tool | Description | Source |
|------|-------------|--------|
| `get_context_profile` | Context window coverage at 32K/100K/200K/1M tiers | v1.2.0 |
| `get_language_checks` | Language-specific findings for a file or directory | v1.3.0 |
| `auto_improve` | Run auto-improve loop, return summary | v1.2.0 |
| `generate_config` | Generate AI config file content for a specific tool | v1.2.0 |

**Implementation:** Add to TOOLS array + handleToolCall() in `src/mcp/server.ts` following existing pattern. ~40 lines per tool.

---

## Version Plan Summary

| Version | Codename | Key Features | Competitive Effect |
|---------|----------|-------------|-------------------|
| **v1.1.0** | Distribution | GitHub Action, per-PR delta, npm publish automation | Closes the #1 adoption gap |
| **v1.2.0** | Intelligence | AI-generated configs, auto-improve loop, context window profiling | Creates unfair advantages via Claude |
| **v1.3.0** | Depth | Language-specific checks (all languages), custom scoring profiles, new MCP tools | Deeper analysis than any competitor |

---

## File Impact Map

### New files:

```
src/
└── analyzers/
    └── languageChecks.ts          # v1.3.0: language-specific regex checks

gididaf/llm-sense-action/          # v1.1.0: separate repo
├── action.yml
├── README.md
├── LICENSE
└── .github/workflows/test.yml

.github/workflows/
└── publish.yml                    # v1.1.0: npm auto-publish on tag
```

### Modified files:

```
# v1.1.0
src/index.ts                       # --pr-delta flag
src/types.ts                       # PrDeltaResult, new CliOptions fields
src/phases/runner.ts               # PR delta prediction path
package.json                       # files field, engines field

# v1.2.0
src/commands/init.ts               # AI-powered generation functions
src/phases/autoFix.ts              # runAutoImprove() loop
src/core/fs.ts                     # buildContextWindowProfile()
src/report/generator.ts            # context profile section
src/report/jsonOutput.ts           # contextProfile in JSON schema
src/mcp/server.ts                  # get_context_profile, auto_improve, generate_config tools

# v1.3.0
src/phases/staticAnalysis.ts       # call runLanguageChecks()
src/phases/scoring.ts              # language penalty integration, profile support
src/constants.ts                   # SCORING_PROFILES, language check patterns
src/report/recommendations.ts      # language-specific recommendations
src/core/history.ts                # profile name in history entries
```

---

## No New Dependencies (Continued)

| Feature | Approach |
|---------|----------|
| GitHub Action | Composite action: Node setup + npx + actions/github-script |
| PR delta prediction | git diff + selective analyzer re-run |
| AI-generated configs | Existing `callClaudeStructured()` |
| Auto-improve loop | Wraps existing `runAutoFix()` |
| Context window profiling | Arithmetic on existing token heatmap data |
| Language-specific checks | Regex patterns per language |
| Custom profiles | JSON file + built-in presets |
| New MCP tools | Existing JSON-RPC handler pattern |

**Dependency count after v1.3.0: still 4.**

---

## Risk Mitigations

| Risk | Mitigation |
|------|-----------|
| GitHub Action comment floods | Deduplication: find existing bot comment, update it |
| AI-generated CLAUDE.md is inaccurate | Use structured output with Zod validation; user reviews before committing; template fallback if Claude unavailable |
| Auto-improve loop runs forever | Hard caps: `--max-iterations 10`, `--max-total-budget 5.00`; skip failed recs; stop when no recs have positive impact |
| Language regex false positives | Only sample 100 files per language; cap penalties per check; exclude test files from penalty scoring |
| Custom profiles break score comparability | Store profile name in history; warn when comparing different profiles in `--trend` |
| PR delta prediction is inaccurate | Label it "predicted" in output; fall back to full analysis if delta seems large (>10 points) |
| npm publish breaks users | Pin `npx llm-sense@latest`; semver for breaking changes; test in CI before publish |

---

## Success Metrics

After v1.3.0, llm-sense should:

- [x] **Be installable with `npx llm-sense` in <10 seconds** (npm publishing)
- [x] **Run in any GitHub Actions PR workflow** (published Action)
- [x] **Generate production-quality CLAUDE.md files** that developers don't need to rewrite (AI-generated)
- [x] **Auto-improve a codebase from C to B grade** with one command (auto-improve loop)
- [x] **Tell developers which model to use** for their specific codebase (context window profiling)
- [x] **Catch language-specific anti-patterns** across all major languages (language checks)
- [x] **Support team-specific scoring priorities** (custom profiles)
- [x] **Respond to PRs in <5 seconds** (per-PR delta prediction)

**The moat widens:** Competitors can copy our static checks. They can't copy AI-generated configs (requires Claude integration), auto-improve (requires empirical testing infrastructure), or LLM-verified scoring (requires LLM invocation). Every milestone makes the Claude integration deeper and harder to replicate.
