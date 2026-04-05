#!/usr/bin/env bash
set -euo pipefail

# ─── llm-sense Benchmark Runner ─────────────────────────────
#
# Clones well-known OSS repos, runs llm-sense static analysis,
# saves results, and generates a comparison table.
#
# Usage:
#   ./scripts/benchmark.sh              # Run all repos
#   ./scripts/benchmark.sh express      # Run specific repo
#   ./scripts/benchmark.sh --skip-clone # Reuse existing clones
#
# Results are saved to benchmarks/results/<timestamp>/

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPOS_FILE="$PROJECT_DIR/benchmarks/repos.json"
CLONE_DIR="/tmp/llm-sense-benchmarks"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
RESULTS_DIR="$PROJECT_DIR/benchmarks/results/$TIMESTAMP"

# Parse arguments
FILTER_REPO=""
SKIP_CLONE=false
for arg in "$@"; do
  case "$arg" in
    --skip-clone) SKIP_CLONE=true ;;
    --help|-h)
      echo "Usage: $0 [repo-name] [--skip-clone]"
      echo ""
      echo "Options:"
      echo "  repo-name      Only benchmark this repo (e.g., 'express')"
      echo "  --skip-clone   Reuse existing clones in /tmp/llm-sense-benchmarks/"
      exit 0
      ;;
    *) FILTER_REPO="$arg" ;;
  esac
done

# Ensure llm-sense is built
echo "Building llm-sense..."
cd "$PROJECT_DIR"
npm run build --silent 2>/dev/null || npm run build

LLM_SENSE="node $PROJECT_DIR/dist/index.js"

# Create results directory
mkdir -p "$RESULTS_DIR"
mkdir -p "$CLONE_DIR"

echo ""
echo "llm-sense Benchmark Runner"
echo "=========================="
echo "Timestamp: $TIMESTAMP"
echo "Results:   $RESULTS_DIR"
echo ""

# Read repos from JSON
REPO_COUNT=$(python3 -c "import json; print(len(json.load(open('$REPOS_FILE'))['repos']))")
echo "Repos configured: $REPO_COUNT"
echo ""

# Track results for summary
declare -a RESULT_NAMES=()
declare -a RESULT_SCORES=()
declare -a RESULT_GRADES=()
declare -a RESULT_LANGS=()
declare -a RESULT_FILES=()
declare -a RESULT_DURATIONS=()

# Process each repo
INDEX=0
while IFS= read -r repo_json; do
  NAME=$(echo "$repo_json" | python3 -c "import json,sys; print(json.load(sys.stdin)['name'])")
  REPO_URL=$(echo "$repo_json" | python3 -c "import json,sys; print(json.load(sys.stdin)['repo'])")
  LANGUAGE=$(echo "$repo_json" | python3 -c "import json,sys; print(json.load(sys.stdin)['language'])")
  DEPTH=$(echo "$repo_json" | python3 -c "import json,sys; print(json.load(sys.stdin).get('cloneDepth', 1))")
  EXTRA_FLAGS=$(echo "$repo_json" | python3 -c "import json,sys; print(json.load(sys.stdin).get('extraFlags', ''))")

  # Filter if requested
  if [ -n "$FILTER_REPO" ] && [ "$FILTER_REPO" != "$NAME" ]; then
    INDEX=$((INDEX + 1))
    continue
  fi

  INDEX=$((INDEX + 1))
  REPO_DIR="$CLONE_DIR/$NAME"

  echo "[$INDEX/$REPO_COUNT] $NAME ($LANGUAGE)"
  echo "  URL: $REPO_URL"

  # Clone
  if [ "$SKIP_CLONE" = false ] || [ ! -d "$REPO_DIR" ]; then
    echo "  Cloning (depth=$DEPTH)..."
    rm -rf "$REPO_DIR"
    if ! git clone --depth "$DEPTH" --single-branch "$REPO_URL" "$REPO_DIR" 2>/dev/null; then
      echo "  ERROR: Clone failed. Skipping."
      echo ""
      continue
    fi
  else
    echo "  Using existing clone"
  fi

  # Run llm-sense
  echo "  Analyzing..."
  START_TIME=$(date +%s)

  RESULT_FILE="$RESULTS_DIR/$NAME.json"
  if $LLM_SENSE --skip-empirical --format json --no-cache $EXTRA_FLAGS --path "$REPO_DIR" > "$RESULT_FILE" 2>/dev/null; then
    END_TIME=$(date +%s)
    DURATION=$((END_TIME - START_TIME))

    # Extract results
    SCORE=$(python3 -c "import json; print(json.load(open('$RESULT_FILE'))['score'])")
    GRADE=$(python3 -c "import json; print(json.load(open('$RESULT_FILE'))['grade'])")
    FILE_COUNT=$(python3 -c "import json; d=json.load(open('$RESULT_FILE')); print(d.get('meta',{}).get('totalFiles', '?'))")

    echo "  Score: $SCORE/100 ($GRADE) — ${DURATION}s — $FILE_COUNT files"

    RESULT_NAMES+=("$NAME")
    RESULT_SCORES+=("$SCORE")
    RESULT_GRADES+=("$GRADE")
    RESULT_LANGS+=("$LANGUAGE")
    RESULT_FILES+=("$FILE_COUNT")
    RESULT_DURATIONS+=("$DURATION")
  else
    echo "  ERROR: Analysis failed"
    RESULT_NAMES+=("$NAME")
    RESULT_SCORES+=("ERR")
    RESULT_GRADES+=("-")
    RESULT_LANGS+=("$LANGUAGE")
    RESULT_FILES+=("-")
    RESULT_DURATIONS+=("-")
  fi

  echo ""
done < <(python3 -c "
import json
repos = json.load(open('$REPOS_FILE'))['repos']
for r in repos:
    print(json.dumps(r))
")

# ─── Generate summary JSON ──────────────────────────────────

SUMMARY_FILE="$RESULTS_DIR/summary.json"
python3 -c "
import json, glob, os

results_dir = '$RESULTS_DIR'
summary = {
    'timestamp': '$TIMESTAMP',
    'llmSenseVersion': '$(node -e "console.log(require('$PROJECT_DIR/package.json').version)")',
    'repos': []
}

for f in sorted(glob.glob(os.path.join(results_dir, '*.json'))):
    if os.path.basename(f) == 'summary.json':
        continue
    try:
        data = json.load(open(f))
        name = os.path.basename(f).replace('.json', '')
        summary['repos'].append({
            'name': name,
            'score': data.get('score'),
            'grade': data.get('grade'),
            'categories': {c['name']: c['score'] for c in data.get('categories', [])},
        })
    except:
        pass

summary['repos'].sort(key=lambda r: r.get('score', 0), reverse=True)
json.dump(summary, open('$SUMMARY_FILE', 'w'), indent=2)
print(f'Summary saved to {os.path.basename(\"$SUMMARY_FILE\")}')
"

# ─── Generate README table ───────────────────────────────────

README_FILE="$PROJECT_DIR/benchmarks/README.md"

python3 -c "
import json, os

summary = json.load(open('$SUMMARY_FILE'))
repos_config = {r['name']: r for r in json.load(open('$REPOS_FILE'))['repos']}

lines = []
lines.append('# llm-sense Benchmarks')
lines.append('')
lines.append('> Automated LLM-friendliness scores for well-known open-source repositories.')
lines.append('> Comparable to [Factory.ai](https://factory.ai) readiness levels.')
lines.append('')
lines.append(f\"Last run: **{summary['timestamp']}** | llm-sense v{summary['llmSenseVersion']}\")
lines.append('')
lines.append('## Results')
lines.append('')
lines.append('| Repository | Language | Score | Grade | Factory.ai | Top Issue |')
lines.append('|------------|----------|------:|:-----:|:----------:|-----------|')

for repo in summary['repos']:
    name = repo['name']
    cfg = repos_config.get(name, {})
    lang = cfg.get('language', '?')
    factory = cfg.get('factoryAiLevel', '')
    factory_str = f'L{factory}' if factory else '—'
    cats = repo.get('categories', {})
    # Find lowest category
    if cats:
        worst = min(cats.items(), key=lambda x: x[1])
        top_issue = f'{worst[0]}: {worst[1]}/100'
    else:
        top_issue = '—'
    lines.append(f\"| [{name}]({cfg.get('repo', '#')}) | {lang} | {repo['score']} | {repo['grade']} | {factory_str} | {top_issue} |\")

lines.append('')
lines.append('## Category Breakdown')
lines.append('')

# Category table
all_cats = set()
for repo in summary['repos']:
    all_cats.update(repo.get('categories', {}).keys())
all_cats = sorted(all_cats)

if all_cats:
    header = '| Repository | ' + ' | '.join(all_cats) + ' |'
    sep = '|------------|' + '|'.join([':---:'] * len(all_cats)) + '|'
    lines.append(header)
    lines.append(sep)
    for repo in summary['repos']:
        cats = repo.get('categories', {})
        row = f\"| {repo['name']} | \" + ' | '.join([str(cats.get(c, '—')) for c in all_cats]) + ' |'
        lines.append(row)

lines.append('')
lines.append('## Methodology')
lines.append('')
lines.append('- All repos analyzed with \`llm-sense --skip-empirical --no-cache\` (static analysis only)')
lines.append('- Shallow clones (\`--depth 1\`) to reduce disk/network usage')
lines.append('- Tree-sitter AST analysis enabled for supported languages')
lines.append('- Scores are deterministic for a given repo state + llm-sense version')
lines.append('')
lines.append('## Running Benchmarks Locally')
lines.append('')
lines.append('\`\`\`bash')
lines.append('# Run all benchmarks')
lines.append('./scripts/benchmark.sh')
lines.append('')
lines.append('# Run a specific repo')
lines.append('./scripts/benchmark.sh express')
lines.append('')
lines.append('# Reuse existing clones')
lines.append('./scripts/benchmark.sh --skip-clone')
lines.append('\`\`\`')
lines.append('')
lines.append('---')
lines.append('*Generated by [llm-sense](https://github.com/gididaf/llm-sense)*')
lines.append('')

with open('$README_FILE', 'w') as f:
    f.write('\n'.join(lines))

print(f'README updated')
"

# ─── Final summary ──────────────────────────────────────────

echo ""
echo "Benchmark Complete"
echo "=================="
echo "Results: $RESULTS_DIR"
echo "Summary: $SUMMARY_FILE"
echo "README:  $README_FILE"

if [ ${#RESULT_NAMES[@]} -gt 0 ]; then
  echo ""
  printf "%-20s %-10s %6s  %s\n" "Repository" "Language" "Score" "Grade"
  printf "%-20s %-10s %6s  %s\n" "--------------------" "----------" "------" "-----"
  for i in "${!RESULT_NAMES[@]}"; do
    printf "%-20s %-10s %6s  %s\n" "${RESULT_NAMES[$i]}" "${RESULT_LANGS[$i]}" "${RESULT_SCORES[$i]}" "${RESULT_GRADES[$i]}"
  done
fi

echo ""
