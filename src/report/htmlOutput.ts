import type { FinalReport, CategoryScore, TokenHeatmapEntry, ExecutableRecommendation, ContextWindowProfile } from '../types.js';

// ─── Color helpers ────────────────────────────────────────

function scoreColor(score: number): string {
  if (score >= 80) return '#4ade80';  // green
  if (score >= 60) return '#facc15';  // yellow
  return '#f87171';                    // red
}

function gradeColor(grade: string): string {
  return grade === 'A' ? '#4ade80' : grade === 'B' ? '#86efac' : grade === 'C' ? '#facc15' : grade === 'D' ? '#fb923c' : '#f87171';
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── SVG Radar Chart ──────────────────────────────────────

function buildRadarChart(categories: CategoryScore[]): string {
  const cx = 200, cy = 200, r = 150;
  const n = categories.length;
  if (n === 0) return '';

  const angleStep = (2 * Math.PI) / n;

  // Grid rings at 25%, 50%, 75%, 100%
  const rings = [0.25, 0.5, 0.75, 1.0];
  const gridLines = rings.map(pct => {
    const points = Array.from({ length: n }, (_, i) => {
      const angle = i * angleStep - Math.PI / 2;
      const x = cx + Math.cos(angle) * r * pct;
      const y = cy + Math.sin(angle) * r * pct;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    return `<polygon points="${points}" fill="none" stroke="#334155" stroke-width="0.5" />`;
  }).join('\n    ');

  // Axis lines
  const axes = Array.from({ length: n }, (_, i) => {
    const angle = i * angleStep - Math.PI / 2;
    const x = cx + Math.cos(angle) * r;
    const y = cy + Math.sin(angle) * r;
    return `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="#334155" stroke-width="0.5" />`;
  }).join('\n    ');

  // Data polygon
  const dataPoints = categories.map((cat, i) => {
    const angle = i * angleStep - Math.PI / 2;
    const pct = cat.score / 100;
    const x = cx + Math.cos(angle) * r * pct;
    const y = cy + Math.sin(angle) * r * pct;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  // Labels
  const labels = categories.map((cat, i) => {
    const angle = i * angleStep - Math.PI / 2;
    const labelR = r + 25;
    const x = cx + Math.cos(angle) * labelR;
    const y = cy + Math.sin(angle) * labelR;
    const anchor = Math.abs(x - cx) < 10 ? 'middle' : x > cx ? 'start' : 'end';
    const color = scoreColor(cat.score);
    return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="${anchor}" dominant-baseline="central" fill="${color}" font-size="11">${escapeHtml(cat.name)} (${cat.score})</text>`;
  }).join('\n    ');

  // Data dots
  const dots = categories.map((cat, i) => {
    const angle = i * angleStep - Math.PI / 2;
    const pct = cat.score / 100;
    const x = cx + Math.cos(angle) * r * pct;
    const y = cy + Math.sin(angle) * r * pct;
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="${scoreColor(cat.score)}" />`;
  }).join('\n    ');

  return `<svg viewBox="0 0 400 400" width="400" height="400" xmlns="http://www.w3.org/2000/svg">
    ${gridLines}
    ${axes}
    <polygon points="${dataPoints}" fill="rgba(59, 130, 246, 0.2)" stroke="#3b82f6" stroke-width="2" />
    ${dots}
    ${labels}
  </svg>`;
}

// ─── Category Bars ────────────────────────────────────────

function buildCategoryBars(categories: CategoryScore[]): string {
  const sorted = [...categories].sort((a, b) => b.score - a.score);
  return sorted.map(cat => {
    const color = scoreColor(cat.score);
    const weightPct = (cat.weight * 100).toFixed(0);
    const finding = cat.findings.length > 0 ? escapeHtml(cat.findings[0]) : '';
    return `
    <div class="cat-row">
      <div class="cat-label">${escapeHtml(cat.name)} <span class="cat-weight">(${weightPct}%)</span></div>
      <div class="cat-bar-bg">
        <div class="cat-bar" style="width:${cat.score}%;background:${color}"></div>
      </div>
      <div class="cat-score" style="color:${color}">${cat.score}</div>
      <div class="cat-finding">${finding}</div>
    </div>`;
  }).join('\n');
}

// ─── Token Heatmap ────────────────────────────────────────

function buildTokenHeatmap(entries: TokenHeatmapEntry[]): string {
  if (entries.length === 0) return '<p class="dim">No token data available</p>';

  const top = entries.slice(0, 15);
  const maxTokens = top[0]?.tokens ?? 1;

  return top.map(e => {
    const pct = (e.tokens / maxTokens) * 100;
    const color = e.isContextHog ? '#f87171' : '#3b82f6';
    const hogBadge = e.isContextHog ? ' <span class="badge-hog">HOG</span>' : '';
    return `
    <div class="heat-row">
      <div class="heat-label">${escapeHtml(e.path)}${hogBadge}</div>
      <div class="heat-bar-bg">
        <div class="heat-bar" style="width:${pct.toFixed(1)}%;background:${color}"></div>
      </div>
      <div class="heat-tokens">${(e.tokens / 1000).toFixed(1)}K (${e.percentage.toFixed(1)}%)</div>
    </div>`;
  }).join('\n');
}

// ─── Context Window Profile ───────────────────────────────

function buildContextProfile(profile: ContextWindowProfile | undefined): string {
  if (!profile) return '<p class="dim">Context profiling not available</p>';

  const tierRows = profile.tiers.map(t => {
    const verdictColor = t.verdict === 'Full' ? '#4ade80' : t.verdict === 'Good' ? '#86efac' : t.verdict === 'Partial' ? '#facc15' : '#f87171';
    return `<tr>
      <td>${t.label}</td>
      <td>${(t.coverage * 100).toFixed(0)}%</td>
      <td style="color:${verdictColor}">${t.verdict}</td>
    </tr>`;
  }).join('\n');

  return `
  <p>Total source tokens: ~${(profile.totalSourceTokens / 1000).toFixed(0)}K</p>
  <p>Recommended minimum: ${profile.recommendedMinimum} | Best experience: ${profile.bestExperience}</p>
  <table class="tier-table">
    <thead><tr><th>Window</th><th>Coverage</th><th>Verdict</th></tr></thead>
    <tbody>${tierRows}</tbody>
  </table>`;
}

// ─── Recommendations Cards ────────────────────────────────

function buildRecommendations(recs: ExecutableRecommendation[]): string {
  if (recs.length === 0) return '<p class="dim">No recommendations</p>';

  return recs.slice(0, 15).map((rec, i) => {
    const effortBadge = rec.estimatedEffort ? `<span class="badge-effort">${rec.estimatedEffort}</span>` : '';
    const steps = rec.implementationSteps.map(s => `<li>${escapeHtml(s)}</li>`).join('');
    return `
    <details class="rec-card">
      <summary>
        <span class="rec-id">${escapeHtml(rec.id)}</span>
        <span class="rec-title">${escapeHtml(rec.title)}</span>
        <span class="rec-impact" style="color:${scoreColor(rec.estimatedScoreImpact * 10)}">+${rec.estimatedScoreImpact} pts</span>
        ${effortBadge}
        <span class="rec-cat">${escapeHtml(rec.category)}</span>
      </summary>
      <div class="rec-body">
        <p><strong>Current:</strong> ${escapeHtml(rec.currentState)}</p>
        <p><strong>Goal:</strong> ${escapeHtml(rec.desiredEndState)}</p>
        <p><strong>Steps:</strong></p>
        <ol>${steps}</ol>
      </div>
    </details>`;
  }).join('\n');
}

// ─── Security Findings ────────────────────────────────────

function buildSecurityFindings(report: FinalReport): string {
  const findings = report.staticAnalysis.security.findings;
  if (findings.length === 0) return '<p style="color:#4ade80">No security issues detected</p>';

  return findings.map(f => {
    const sevColor = f.severity === 'high' ? '#f87171' : f.severity === 'medium' ? '#facc15' : '#94a3b8';
    return `<div class="sec-finding">
      <span class="sec-sev" style="color:${sevColor}">${f.severity.toUpperCase()}</span>
      <span class="sec-check">${escapeHtml(f.check)}</span>: ${escapeHtml(f.detail)}
    </div>`;
  }).join('\n');
}

// ─── Config Drift ─────────────────────────────────────────

function buildConfigDrift(report: FinalReport): string {
  const drift = report.staticAnalysis.documentation.configDrift;
  if (drift.staleReferences.length === 0) {
    if (drift.totalReferences > 0) {
      return `<p style="color:#4ade80">All ${drift.totalReferences} config references are fresh (100%)</p>`;
    }
    return '<p class="dim">No config references to validate</p>';
  }

  return drift.staleReferences.map(ref => {
    return `<div class="drift-ref">
      <code>${escapeHtml(ref.file)}:${ref.line}</code> — <code>${escapeHtml(ref.reference)}</code>
      <span class="dim"> (${ref.type}: ${escapeHtml(ref.reason)})</span>
    </div>`;
  }).join('\n');
}

// ─── Main HTML Generator ─────────────────────────────────

export function generateHtmlReport(report: FinalReport): string {
  const { overallScore, grade, categories, recommendations, staticAnalysis } = report;
  const repoName = report.targetPath.split('/').pop() ?? 'repo';
  const date = new Date(report.generatedAt).toLocaleDateString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
  });

  const radarSvg = buildRadarChart(categories);
  const categoryBars = buildCategoryBars(categories);
  const tokenHeatmap = buildTokenHeatmap(staticAnalysis.tokenHeatmap.entries);
  const contextProfile = buildContextProfile(staticAnalysis.contextProfile);
  const recsHtml = buildRecommendations(recommendations);
  const securityHtml = buildSecurityFindings(report);
  const driftHtml = buildConfigDrift(report);
  const jsonDump = JSON.stringify(report, null, 2);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>llm-sense Report — ${escapeHtml(repoName)}</title>
<style>
  :root {
    --bg: #0f172a; --surface: #1e293b; --border: #334155;
    --text: #e2e8f0; --dim: #64748b; --accent: #3b82f6;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace;
    background: var(--bg); color: var(--text);
    line-height: 1.6; padding: 2rem; max-width: 1100px; margin: 0 auto;
  }
  h1, h2, h3 { color: #f1f5f9; }
  h2 { margin: 2rem 0 1rem; padding-bottom: 0.5rem; border-bottom: 1px solid var(--border); }
  a { color: var(--accent); }
  code { background: var(--surface); padding: 0.1em 0.4em; border-radius: 3px; font-size: 0.9em; }
  .dim { color: var(--dim); }
  p { margin: 0.5rem 0; }
  table { border-collapse: collapse; width: 100%; margin: 0.5rem 0; }
  th, td { padding: 0.4rem 0.8rem; text-align: left; border-bottom: 1px solid var(--border); }
  th { color: var(--dim); font-weight: 600; }

  /* Header */
  .header { text-align: center; margin-bottom: 2rem; }
  .header h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
  .score-big { font-size: 4rem; font-weight: 800; margin: 0.5rem 0; }
  .grade-badge {
    display: inline-block; padding: 0.3rem 1rem; border-radius: 6px;
    font-size: 1.2rem; font-weight: 700; margin: 0.5rem 0;
  }
  .header-meta { color: var(--dim); font-size: 0.85rem; }

  /* Radar */
  .radar-container { text-align: center; margin: 1rem 0; }

  /* Category bars */
  .cat-row { display: grid; grid-template-columns: 200px 1fr 50px; gap: 8px; align-items: center; padding: 6px 0; }
  .cat-label { font-size: 0.85rem; }
  .cat-weight { color: var(--dim); font-size: 0.75rem; }
  .cat-bar-bg { background: var(--surface); border-radius: 4px; height: 20px; overflow: hidden; }
  .cat-bar { height: 100%; border-radius: 4px; transition: width 0.3s; }
  .cat-score { font-weight: 700; text-align: right; font-size: 0.9rem; }
  .cat-finding { grid-column: 1/-1; color: var(--dim); font-size: 0.78rem; padding-left: 1rem; }

  /* Token heatmap */
  .heat-row { display: grid; grid-template-columns: 250px 1fr 120px; gap: 8px; align-items: center; padding: 4px 0; }
  .heat-label { font-size: 0.82rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .heat-bar-bg { background: var(--surface); border-radius: 3px; height: 14px; overflow: hidden; }
  .heat-bar { height: 100%; border-radius: 3px; }
  .heat-tokens { color: var(--dim); font-size: 0.8rem; text-align: right; }
  .badge-hog { background: #991b1b; color: #fca5a5; padding: 0 4px; border-radius: 3px; font-size: 0.7rem; margin-left: 4px; }

  /* Context tiers */
  .tier-table th { font-size: 0.8rem; }
  .tier-table td { font-size: 0.85rem; }

  /* Recommendations */
  .rec-card { background: var(--surface); border-radius: 6px; margin: 0.5rem 0; padding: 0.8rem 1rem; }
  .rec-card summary { cursor: pointer; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .rec-card summary::-webkit-details-marker { display: none; }
  .rec-card summary::before { content: '▸'; margin-right: 4px; }
  .rec-card[open] summary::before { content: '▾'; }
  .rec-id { color: var(--dim); font-size: 0.8rem; }
  .rec-title { font-weight: 600; flex: 1; }
  .rec-impact { font-weight: 700; }
  .rec-cat { color: var(--dim); font-size: 0.78rem; }
  .badge-effort { background: #1e3a5f; color: #93c5fd; padding: 0 6px; border-radius: 3px; font-size: 0.72rem; }
  .rec-body { margin-top: 0.8rem; padding-top: 0.8rem; border-top: 1px solid var(--border); }
  .rec-body ol { padding-left: 1.5rem; margin: 0.5rem 0; }
  .rec-body li { margin: 0.3rem 0; font-size: 0.85rem; }

  /* Security / Drift */
  .sec-finding, .drift-ref { padding: 4px 0; font-size: 0.85rem; }
  .sec-sev { font-weight: 700; margin-right: 6px; }
  .sec-check { font-weight: 600; }

  /* JSON dump */
  .json-dump { background: var(--surface); border-radius: 6px; padding: 1rem; overflow-x: auto; font-size: 0.75rem; max-height: 400px; overflow-y: auto; }

  /* Print */
  @media print {
    body { background: white; color: #1e293b; }
    .header, h2, .cat-label, .rec-title { color: #0f172a; }
    details { break-inside: avoid; }
    details[open] { display: block; }
  }

  /* Responsive */
  @media (max-width: 700px) {
    .cat-row { grid-template-columns: 1fr 50px; }
    .cat-label { grid-column: 1/-1; }
    .heat-row { grid-template-columns: 1fr 80px; }
    .heat-label { grid-column: 1/-1; }
  }
</style>
</head>
<body>

<!-- Header -->
<div class="header">
  <h1>llm-sense Report</h1>
  <p class="dim">${escapeHtml(repoName)} &mdash; ${date}</p>
  <div class="score-big" style="color:${scoreColor(overallScore)}">${overallScore}</div>
  <div class="grade-badge" style="background:${gradeColor(grade)}22;color:${gradeColor(grade)}">Grade ${grade}</div>
  <div class="header-meta">
    ${staticAnalysis.fileSizes.totalFiles} files &bull;
    ${staticAnalysis.fileSizes.totalLines.toLocaleString()} lines &bull;
    ${report.recommendations.length} improvements &bull;
    $${report.totalCostUsd.toFixed(2)} cost &bull;
    ${(report.totalDurationMs / 1000).toFixed(1)}s
  </div>
</div>

<!-- Radar Chart -->
<h2>Category Radar</h2>
<div class="radar-container">
${radarSvg}
</div>

<!-- Category Breakdown -->
<h2>Category Breakdown</h2>
${categoryBars}

<!-- Token Heatmap -->
<h2>Token Heatmap</h2>
<p class="dim">Top directories by estimated token consumption (total: ~${(staticAnalysis.tokenHeatmap.total / 1000).toFixed(0)}K tokens)</p>
${tokenHeatmap}

<!-- Context Window Profile -->
<h2>Context Window Profile</h2>
${contextProfile}

<!-- Recommendations -->
<h2>Recommendations (${recommendations.length})</h2>
${recsHtml}

<!-- Config Drift -->
<h2>Config Drift</h2>
${driftHtml}

<!-- Security -->
<h2>Security</h2>
${securityHtml}

<!-- Raw JSON -->
<h2>Raw JSON Data</h2>
<details>
  <summary class="dim">Expand full analysis JSON</summary>
  <pre class="json-dump">${escapeHtml(jsonDump)}</pre>
</details>

<p class="dim" style="text-align:center;margin-top:2rem">
  Generated by <a href="https://github.com/gididaf/llm-sense">llm-sense</a>
</p>
</body>
</html>`;
}

// ─── HTML Comparison View ─────────────────────────────────

export function generateHtmlComparison(
  reportA: FinalReport,
  reportB: FinalReport,
): string {
  const nameA = reportA.targetPath.split('/').pop() ?? 'repo-a';
  const nameB = reportB.targetPath.split('/').pop() ?? 'repo-b';

  // Build overlaid radar chart
  const categoriesA = reportA.categories;
  const categoriesB = reportB.categories;
  const radarSvg = buildDualRadarChart(categoriesA, categoriesB, nameA, nameB);

  // Category comparison
  const categoryComparison = buildCategoryComparison(categoriesA, categoriesB);

  // Winner summary
  const winsA = categoriesA.filter((ca, i) => i < categoriesB.length && ca.score > categoriesB[i].score).length;
  const winsB = categoriesB.filter((cb, i) => i < categoriesA.length && cb.score > categoriesA[i].score).length;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>llm-sense Comparison — ${escapeHtml(nameA)} vs ${escapeHtml(nameB)}</title>
<style>
  :root { --bg: #0f172a; --surface: #1e293b; --border: #334155; --text: #e2e8f0; --dim: #64748b; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace; background: var(--bg); color: var(--text); line-height: 1.6; padding: 2rem; max-width: 1100px; margin: 0 auto; }
  h1, h2 { color: #f1f5f9; }
  h2 { margin: 2rem 0 1rem; padding-bottom: 0.5rem; border-bottom: 1px solid var(--border); }
  .dim { color: var(--dim); }
  .header-compare { display: flex; justify-content: center; gap: 3rem; text-align: center; margin: 2rem 0; }
  .repo-col h2 { border: none; margin: 0; }
  .score-big { font-size: 3rem; font-weight: 800; }
  .radar-container { text-align: center; margin: 1rem 0; }
  .legend { display: flex; justify-content: center; gap: 2rem; margin: 1rem 0; }
  .legend-item { display: flex; align-items: center; gap: 6px; }
  .legend-dot { width: 12px; height: 12px; border-radius: 50%; }
  .cmp-row { display: grid; grid-template-columns: 180px 1fr 60px 1fr 60px; gap: 8px; align-items: center; padding: 6px 0; }
  .cmp-label { font-size: 0.85rem; }
  .cmp-bar-bg { background: var(--surface); border-radius: 4px; height: 16px; overflow: hidden; }
  .cmp-bar { height: 100%; border-radius: 4px; }
  .cmp-score { font-weight: 700; text-align: center; font-size: 0.85rem; }
</style>
</head>
<body>

<h1 style="text-align:center">llm-sense Comparison</h1>

<div class="header-compare">
  <div class="repo-col">
    <h2>${escapeHtml(nameA)}</h2>
    <div class="score-big" style="color:${scoreColor(reportA.overallScore)}">${reportA.overallScore}</div>
    <div style="color:${gradeColor(reportA.grade)}">Grade ${reportA.grade}</div>
  </div>
  <div style="font-size:2rem;align-self:center;color:var(--dim)">vs</div>
  <div class="repo-col">
    <h2>${escapeHtml(nameB)}</h2>
    <div class="score-big" style="color:${scoreColor(reportB.overallScore)}">${reportB.overallScore}</div>
    <div style="color:${gradeColor(reportB.grade)}">Grade ${reportB.grade}</div>
  </div>
</div>

<p style="text-align:center" class="dim">${escapeHtml(nameA)} wins ${winsA} categories &bull; ${escapeHtml(nameB)} wins ${winsB} categories &bull; ${categoriesA.length - winsA - winsB} tied</p>

<h2>Overlaid Radar</h2>
<div class="radar-container">
${radarSvg}
</div>
<div class="legend">
  <div class="legend-item"><div class="legend-dot" style="background:#3b82f6"></div>${escapeHtml(nameA)}</div>
  <div class="legend-item"><div class="legend-dot" style="background:#f97316"></div>${escapeHtml(nameB)}</div>
</div>

<h2>Category Comparison</h2>
${categoryComparison}

<p class="dim" style="text-align:center;margin-top:2rem">Generated by <a href="https://github.com/gididaf/llm-sense" style="color:#3b82f6">llm-sense</a></p>
</body>
</html>`;
}

function buildDualRadarChart(catsA: CategoryScore[], catsB: CategoryScore[], _nameA: string, _nameB: string): string {
  const cx = 200, cy = 200, r = 150;
  // Use category names from A; match B by name
  const names = catsA.map(c => c.name);
  const n = names.length;
  if (n === 0) return '';
  const angleStep = (2 * Math.PI) / n;

  const bMap = new Map(catsB.map(c => [c.name, c.score]));

  const rings = [0.25, 0.5, 0.75, 1.0];
  const gridLines = rings.map(pct => {
    const points = Array.from({ length: n }, (_, i) => {
      const angle = i * angleStep - Math.PI / 2;
      return `${(cx + Math.cos(angle) * r * pct).toFixed(1)},${(cy + Math.sin(angle) * r * pct).toFixed(1)}`;
    }).join(' ');
    return `<polygon points="${points}" fill="none" stroke="#334155" stroke-width="0.5" />`;
  }).join('\n    ');

  const axes = Array.from({ length: n }, (_, i) => {
    const angle = i * angleStep - Math.PI / 2;
    return `<line x1="${cx}" y1="${cy}" x2="${(cx + Math.cos(angle) * r).toFixed(1)}" y2="${(cy + Math.sin(angle) * r).toFixed(1)}" stroke="#334155" stroke-width="0.5" />`;
  }).join('\n    ');

  const polyA = names.map((_, i) => {
    const angle = i * angleStep - Math.PI / 2;
    const pct = catsA[i].score / 100;
    return `${(cx + Math.cos(angle) * r * pct).toFixed(1)},${(cy + Math.sin(angle) * r * pct).toFixed(1)}`;
  }).join(' ');

  const polyB = names.map((name, i) => {
    const angle = i * angleStep - Math.PI / 2;
    const pct = (bMap.get(name) ?? 0) / 100;
    return `${(cx + Math.cos(angle) * r * pct).toFixed(1)},${(cy + Math.sin(angle) * r * pct).toFixed(1)}`;
  }).join(' ');

  const labels = names.map((name, i) => {
    const angle = i * angleStep - Math.PI / 2;
    const labelR = r + 25;
    const x = cx + Math.cos(angle) * labelR;
    const y = cy + Math.sin(angle) * labelR;
    const anchor = Math.abs(x - cx) < 10 ? 'middle' : x > cx ? 'start' : 'end';
    return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="${anchor}" dominant-baseline="central" fill="#94a3b8" font-size="10">${escapeHtml(name)}</text>`;
  }).join('\n    ');

  return `<svg viewBox="0 0 400 400" width="400" height="400" xmlns="http://www.w3.org/2000/svg">
    ${gridLines}
    ${axes}
    <polygon points="${polyA}" fill="rgba(59,130,246,0.15)" stroke="#3b82f6" stroke-width="2" />
    <polygon points="${polyB}" fill="rgba(249,115,22,0.15)" stroke="#f97316" stroke-width="2" />
    ${labels}
  </svg>`;
}

function buildCategoryComparison(catsA: CategoryScore[], catsB: CategoryScore[]): string {
  const bMap = new Map(catsB.map(c => [c.name, c.score]));
  const sorted = [...catsA].sort((a, b) => {
    const deltaA = a.score - (bMap.get(a.name) ?? 0);
    const deltaB = b.score - (bMap.get(b.name) ?? 0);
    return Math.abs(deltaB) - Math.abs(deltaA);
  });

  return sorted.map(cat => {
    const scoreB = bMap.get(cat.name) ?? 0;
    return `
    <div class="cmp-row">
      <div class="cmp-label">${escapeHtml(cat.name)}</div>
      <div class="cmp-bar-bg"><div class="cmp-bar" style="width:${cat.score}%;background:#3b82f6"></div></div>
      <div class="cmp-score" style="color:#3b82f6">${cat.score}</div>
      <div class="cmp-bar-bg"><div class="cmp-bar" style="width:${scoreB}%;background:#f97316"></div></div>
      <div class="cmp-score" style="color:#f97316">${scoreB}</div>
    </div>`;
  }).join('\n');
}
