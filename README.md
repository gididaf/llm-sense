# llm-sense

Analyze how LLM-friendly your codebase is. Get a score, detailed findings, and self-contained improvement tasks that Claude Code (or any AI coding assistant) can execute directly.

## Why

When LLMs work on your code, their effectiveness depends on how the codebase is structured. Messy structure = wasted tokens, noisy context, slower tasks. **llm-sense** measures this empirically and tells you exactly what to fix.

## Install

```bash
npx llm-sense --path ./your-project
```

Or install globally:

```bash
npm install -g llm-sense
```

## What It Does

```
Phase 1: Static Analysis     (free, ~300ms)    → file sizes, structure, naming, docs, noise
Phase 2: LLM Understanding   (1 Claude call)   → architecture, tech stack, complexity
Phase 3: Task Generation      (1 Claude call)   → synthetic bugs + features
Phase 4: Empirical Testing    (N Claude calls)  → solve tasks in git worktrees, measure results
Phase 5: Scoring              (instant)         → weighted 0-100 score across 8 categories
Phase 6: Report Generation    (instant)         → detailed MD with LLM-executable improvement tasks
```

## Quick Start

**Static-only scan (free, instant):**

```bash
llm-sense --skip-empirical --path ./my-app
```

**Full scan with empirical testing (requires Claude Code CLI):**

```bash
llm-sense --path ./my-app --bugs 3 --features 3
```

**View score history:**

```bash
llm-sense --history --path ./my-app
```

## Output

A Markdown report with:

- **Overall score** (0-100) with letter grade
- **8 category scores**: Documentation, File Sizes, Structure, Modularity, Context Efficiency, Naming, Task Completion, Token Efficiency
- **Self-contained improvement tasks** — each task has current state, desired end state, implementation steps, and acceptance criteria. Copy any task and paste it into Claude Code to implement it.
- **CLAUDE.md draft generation** — if your project is missing a CLAUDE.md, the report includes a full draft based on LLM analysis
- **Score history tracking** — run repeatedly to see improvement over time

## Scoring Categories

| Category | What it measures | Weight |
|---|---|---|
| Documentation | CLAUDE.md quality (8 sections), README, comments, AI tool configs | 20% |
| Task Completion | Can Claude actually solve tasks in your codebase? (empirical) | 20% |
| File Sizes | Median/P90 file sizes, god-file detection | 15% |
| Structure | Directory depth, files per directory | 10% |
| Modularity | Module organization, barrel exports, single-file dirs | 10% |
| Context Efficiency | Source-to-noise ratio, generated files, binaries | 10% |
| Token Efficiency | Tokens consumed per successful task (empirical) | 10% |
| Naming | File naming convention consistency | 5% |

## CLI Options

```
llm-sense [options]

Options:
  --path <dir>              Target codebase (default: .)
  --bugs <n>                Synthetic bug tasks (default: 5)
  --features <n>            Synthetic feature tasks (default: 5)
  --output <file>           Report file path (default: llm-sense-report.md)
  --max-budget-per-task <$> Max USD per empirical task (default: 1.00)
  --max-turns-per-task <n>  Max turns per task (default: 30)
  --skip-empirical          Skip Phases 2-4 (free, instant, static-only)
  --model <model>           Override Claude model
  --verbose                 Detailed progress output
  --history                 Show score history
  -V, --version             Version
  -h, --help                Help
```

## Requirements

- **Node.js 18+**
- **Claude Code CLI** (for Phases 2-4) — install from [claude.ai/code](https://claude.ai/code)
- Static analysis (Phase 1) works without Claude Code CLI

## How the Report Works

Each improvement task in the report is designed to be **copy-pasted directly into Claude Code** or fed into [Ralph](https://github.com/frankbria/ralph-claude-code) for autonomous execution. Tasks are self-contained — no context from other tasks is needed.

Example task from a report:

```markdown
### Task 1: Add 2 missing sections to CLAUDE.md
**Priority 1** | **Category:** Documentation | **Estimated impact:** +6 points

#### Current State
CLAUDE.md exists (124 lines) but is missing: Common Patterns, Gotchas.

#### Implementation Steps
1. Add a "## Common Patterns" section with relevant content
2. Add a "## Gotchas" section with relevant content

#### Acceptance Criteria
- [ ] CLAUDE.md contains a "Common Patterns" section
- [ ] CLAUDE.md contains a "Gotchas" section
```

## License

MIT
