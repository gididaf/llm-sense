import type { FinalReport, ExecutableRecommendation } from '../types.js';

// Re-export recommendation builders from their dedicated module
export { buildExecutableRecommendations, generateClaudeMdDraft } from './recommendations.js';

// Generates the final Markdown report from a FinalReport object.
// The report structure is designed to be both human-readable and LLM-parseable:
// score summary → category breakdown → self-contained improvement tasks → detailed findings.
export function generateReport(report: FinalReport): string {
  const lines: string[] = [];

  // Header with metadata
  lines.push(`# LLM-Sense Report: ${report.understanding?.projectName ?? 'Unknown Project'}`);
  lines.push('');
  lines.push(`**Generated:** ${report.generatedAt}`);
  lines.push(`**Target:** \`${report.targetPath}\``);
  lines.push(`**Total cost:** $${report.totalCostUsd.toFixed(2)} | **Duration:** ${formatDuration(report.totalDurationMs)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  // Overall Score with delta from previous run (if history exists)
  let scoreHeader = `## Overall Score: ${report.overallScore}/100 (Grade: ${report.grade})`;
  if (report.previousScore !== null) {
    const delta = report.overallScore - report.previousScore;
    const deltaStr = delta >= 0 ? `+${delta}` : `${delta}`;
    scoreHeader += ` [Previous: ${report.previousScore} -> ${report.overallScore} (${deltaStr})]`;
  }
  lines.push(scoreHeader);
  lines.push('');
  lines.push(`> ${getGradeSummary(report.grade)}`);
  lines.push('');

  // Category Breakdown Table — sorted by weight so highest-impact categories appear first
  lines.push('### Category Breakdown');
  lines.push('');
  lines.push('| Category | Score | Weight | Weighted |');
  lines.push('|----------|-------|--------|----------|');
  for (const cat of report.categories.sort((a, b) => b.weight - a.weight)) {
    const weighted = (cat.score * cat.weight).toFixed(1);
    lines.push(`| ${cat.name} | ${cat.score} | ${(cat.weight * 100).toFixed(0)}% | ${weighted} |`);
  }
  lines.push(`| **Total** | | | **${report.overallScore}** |`);
  lines.push('');
  lines.push('---');
  lines.push('');

  // Token Budget Heatmap — always shown
  const heatmap = report.staticAnalysis.tokenHeatmap;
  if (heatmap.entries.length > 0) {
    lines.push('### Token Budget Heatmap');
    lines.push('');
    const maxTokens = heatmap.entries[0].tokens;
    const barWidth = 18;

    for (const entry of heatmap.entries.slice(0, 15)) {
      const barLen = Math.max(1, Math.round((entry.tokens / maxTokens) * barWidth));
      const bar = '\u2588'.repeat(barLen) + '\u2591'.repeat(barWidth - barLen);
      const hog = entry.isContextHog ? ' \u26A0\uFE0F context hog' : '';
      lines.push(`  ${entry.path.padEnd(25)} ${entry.tokens.toLocaleString().padStart(8)} tokens  (${entry.percentage.toFixed(1).padStart(4)}%) ${bar}${hog}`);
    }
    if (heatmap.entries.length > 15) {
      lines.push(`  ... and ${heatmap.entries.length - 15} more directories`);
    }
    lines.push(`  **Total:** ~${heatmap.total.toLocaleString()} tokens across ${heatmap.totalFiles} source files`);
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  // Context Window Profile — always shown
  const contextProfile = report.staticAnalysis.contextProfile;
  if (contextProfile) {
    lines.push('### Context Window Profile');
    lines.push('');
    lines.push(`Total source tokens (estimated): ~${contextProfile.totalSourceTokens.toLocaleString()}`);
    lines.push('');
    lines.push('| Context Window | Coverage | Verdict |');
    lines.push('|----------------|----------|---------|');
    for (const tier of contextProfile.tiers) {
      lines.push(`| ${tier.label} | ${tier.coverage}% | ${tier.verdict} |`);
    }
    lines.push('');
    lines.push(`**Recommended minimum:** ${contextProfile.recommendedMinimum}`);
    lines.push(`**Best experience:** ${contextProfile.bestExperience}`);
    lines.push('');
    if (contextProfile.topConsumers.length > 0) {
      lines.push('Top context consumers:');
      for (const c of contextProfile.topConsumers) {
        lines.push(`  ${c.path.padEnd(25)} ${c.percentage.toFixed(1)}% (${c.tokens.toLocaleString()} tokens)`);
      }
      lines.push('');
    }
    lines.push('---');
    lines.push('');
  }

  // Context Window Optimization — show if any savings possible
  if (report.tokenOptimization && report.tokenOptimization.potentialSavings.savingsPercent > 5) {
    const opt = report.tokenOptimization;
    lines.push('### Context Window Optimization');
    lines.push('');
    lines.push(`**~${opt.potentialSavings.savingsPercent}% token savings** possible (${(opt.potentialSavings.excludeTokens / 1000).toFixed(0)}K exclude + ${(opt.potentialSavings.compressTokens / 1000).toFixed(0)}K compress of ${(opt.potentialSavings.totalTokens / 1000).toFixed(0)}K total)`);
    lines.push('');

    if (opt.excludeRecommendations.length > 0) {
      lines.push('#### Files to Exclude');
      lines.push('');
      lines.push('| File | Tokens | Reason |');
      lines.push('|------|--------|--------|');
      for (const r of opt.excludeRecommendations.slice(0, 10)) {
        lines.push(`| \`${r.path}\` | ${(r.tokens / 1000).toFixed(1)}K | ${r.reason} |`);
      }
      lines.push('');
    }

    if (opt.compressRecommendations.length > 0) {
      lines.push('#### Files to Compress');
      lines.push('');
      lines.push('| File | Current | Compressed | Strategy |');
      lines.push('|------|---------|-----------|----------|');
      for (const r of opt.compressRecommendations.slice(0, 5)) {
        lines.push(`| \`${r.path}\` | ${(r.tokens / 1000).toFixed(1)}K | ~${(r.estimatedCompressedTokens / 1000).toFixed(1)}K | ${r.strategy} |`);
      }
      lines.push('');
    }

    lines.push('> Run `llm-sense --generate-ignore` to auto-create `.claudeignore`, `.cursorignore`, `.copilotignore`');
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  // Config Drift — show if any stale references found
  const drift = report.staticAnalysis.documentation.configDrift;
  if (drift.staleReferences.length > 0) {
    lines.push('### Config Drift');
    lines.push('');
    lines.push(`**${drift.staleReferences.length} stale reference(s)** found across config files (freshness: ${drift.freshnessScore}%)`);
    lines.push('');
    for (const ref of drift.staleReferences) {
      lines.push(`- **${ref.file}** line ${ref.line}: \`${ref.reference}\` — ${ref.reason}`);
    }
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  // Git History Analysis — show if --git-history was used
  const gitHistory = report.staticAnalysis.gitHistory;
  if (gitHistory) {
    lines.push('### Git History Analysis');
    lines.push('');
    lines.push(`**${gitHistory.totalCommitsAnalyzed.toLocaleString()} commits** analyzed`);
    lines.push('');

    // File Importance (top 10)
    if (gitHistory.fileImportance.length > 0) {
      lines.push('#### Most Important Files (for LLM context)');
      lines.push('');
      lines.push('| File | Importance | Commits | Last Modified |');
      lines.push('|------|-----------|---------|---------------|');
      for (const f of gitHistory.fileImportance.slice(0, 10)) {
        const date = f.lastModified !== 'unknown' ? f.lastModified.split(' ')[0] : '—';
        lines.push(`| \`${f.path}\` | ${f.score}/100 | ${f.commitCount} | ${date} |`);
      }
      lines.push('');
    }

    // Hotspots
    if (gitHistory.hotspots.length > 0) {
      lines.push('#### Hotspots (high churn + high complexity)');
      lines.push('');
      lines.push('| File | Churn | Complexity | Risk |');
      lines.push('|------|-------|-----------|------|');
      for (const h of gitHistory.hotspots.slice(0, 10)) {
        const riskEmoji = h.risk === 'high' ? '🔴' : h.risk === 'medium' ? '🟡' : '🟢';
        lines.push(`| \`${h.path}\` | ${h.changeFrequency} commits | ${h.complexity} | ${riskEmoji} ${h.risk} |`);
      }
      lines.push('');
    }

    // Knowledge Concentration
    if (gitHistory.knowledgeConcentration.length > 0) {
      lines.push('#### Bus Factor Risk');
      lines.push('');
      lines.push('| File | Authors | Dominant Author | % |');
      lines.push('|------|---------|----------------|---|');
      for (const k of gitHistory.knowledgeConcentration.slice(0, 10)) {
        lines.push(`| \`${k.path}\` | ${k.authors} | ${k.dominantAuthor} | ${k.dominantAuthorPct}% |`);
      }
      lines.push('');
    }

    // Convention Trend
    if (gitHistory.conventionTrend.direction !== 'stable') {
      lines.push(`#### Convention Trend: **${gitHistory.conventionTrend.direction}**`);
      lines.push('');
      lines.push(`Recent consistency: ${gitHistory.conventionTrend.recentConsistency}% | Older: ${gitHistory.conventionTrend.olderConsistency}%`);
      lines.push('');
    }

    lines.push('---');
    lines.push('');
  }

  // LLM Lint Findings — show if any findings
  if (report.llmLint && report.llmLint.findings.length > 0) {
    const lint = report.llmLint;
    lines.push('### LLM Lint Findings');
    lines.push('');
    lines.push(`**${lint.findings.length} finding(s)** from ${lint.rulesEvaluated} rules across ${lint.candidatesEvaluated} candidates (cost: $${lint.totalCostUsd.toFixed(2)})`);
    lines.push('');
    lines.push('| Severity | Rule | File | Function | Issue |');
    lines.push('|----------|------|------|----------|-------|');
    for (const f of lint.findings.slice(0, 20)) {
      const sev = f.severity === 'error' ? '🔴' : f.severity === 'warning' ? '🟡' : '🔵';
      const explanation = f.explanation.length > 60 ? f.explanation.slice(0, 57) + '...' : f.explanation;
      lines.push(`| ${sev} ${f.severity} | ${f.ruleName} | \`${f.file}:${f.startLine}\` | \`${f.functionName}\` | ${explanation} |`);
    }
    if (lint.findings.length > 20) {
      lines.push(`| | | | | _...and ${lint.findings.length - 20} more_ |`);
    }
    lines.push('');

    // Show suggested fixes for top findings
    const topFindings = lint.findings.filter(f => f.severity !== 'info').slice(0, 5);
    if (topFindings.length > 0) {
      lines.push('#### Suggested Fixes');
      lines.push('');
      for (const f of topFindings) {
        lines.push(`- **\`${f.functionName}\`** (${f.file}:${f.startLine}): ${f.suggestedFix}`);
      }
      lines.push('');
    }

    lines.push('---');
    lines.push('');
  }

  // Improvement Tasks with roadmap
  if (report.recommendations.length > 0) {
    lines.push('## How to Use This Report');
    lines.push('');
    lines.push('> This report is the single artifact you need. Pass it to Claude Code, Ralph, or any');
    lines.push('> LLM-powered tool. The roadmap below shows the recommended order. Each task is');
    lines.push('> **self-contained** — copy any task and execute it independently.');
    lines.push('>');
    lines.push('> **Quick fix:** `llm-sense --fix --fix-id <rec-id>` applies a task automatically.');
    lines.push('');

    // Roadmap table — sorted by impact, shows projected score progression
    const sorted = [...report.recommendations].sort((a, b) => b.estimatedScoreImpact - a.estimatedScoreImpact);
    lines.push('### Roadmap');
    lines.push('');
    lines.push('| # | Task | Impact | Effort | Projected Score |');
    lines.push('|---|------|--------|--------|-----------------|');
    let projected = report.overallScore;
    for (let i = 0; i < sorted.length; i++) {
      const rec = sorted[i];
      projected = Math.min(100, projected + rec.estimatedScoreImpact);
      const title = rec.title.length > 55 ? rec.title.slice(0, 52) + '...' : rec.title;
      lines.push(`| ${i + 1} | ${title} | +${rec.estimatedScoreImpact} | ${rec.estimatedEffort ?? '—'} | ${projected}/100 |`);
    }
    lines.push('');
    lines.push(`> **Current:** ${report.overallScore}/100 → **Projected:** ${projected}/100 (+${projected - report.overallScore} points)`);
    lines.push('');
    lines.push('---');
    lines.push('');

    // Full task details
    lines.push('## Improvement Tasks');
    lines.push('');

    for (let i = 0; i < report.recommendations.length; i++) {
      const rec = report.recommendations[i];
      lines.push(formatRecommendation(rec, i + 1));
      lines.push('');
    }

    lines.push('---');
    lines.push('');
  }

  // Codebase Profile (only present when empirical mode runs Phase 2)
  if (report.understanding) {
    lines.push('## Codebase Profile');
    lines.push('');
    lines.push(`- **Description:** ${report.understanding.description}`);
    lines.push(`- **Tech Stack:** ${report.understanding.techStack.map(t => t.name).join(', ')}`);
    lines.push(`- **Architecture:** ${report.understanding.architecture.pattern}`);
    lines.push(`- **Complexity:** ${report.understanding.complexity}`);
    lines.push(`- **Entry Points:** ${report.understanding.architecture.entryPoints.join(', ')}`);
    lines.push(`- **Estimated context size:** ~${Math.round(report.understanding.contextWindowEstimate.totalTokensEstimate / 1000)}K tokens (${report.understanding.contextWindowEstimate.fitsInSingleContext ? 'fits in single context' : 'does NOT fit in single context'})`);
    lines.push('');

    if (report.understanding.llmFriendlinessNotes.length > 0) {
      lines.push('**LLM Friendliness Notes:**');
      for (const note of report.understanding.llmFriendlinessNotes) {
        lines.push(`- ${note}`);
      }
      lines.push('');
    }

    lines.push('---');
    lines.push('');
  }

  // Detailed Findings per Category — raw data behind the scores
  lines.push('## Detailed Findings');
  lines.push('');
  for (const cat of report.categories) {
    lines.push(`### ${cat.name} (${cat.score}/100)`);
    lines.push('');
    if (cat.findings.length > 0) {
      for (const f of cat.findings) {
        lines.push(`- ${f}`);
      }
      lines.push('');
    }
  }

  lines.push('---');
  lines.push('');

  // Empirical Testing Results table (only when Phase 4 runs)
  if (report.taskResults.length > 0) {
    lines.push('## Empirical Testing Results');
    lines.push('');

    const successCount = report.taskResults.filter(r => r.success).length;
    const avgTurns = report.taskResults.reduce((s, r) => s + r.numTurns, 0) / report.taskResults.length;
    const avgCost = report.taskResults.reduce((s, r) => s + r.totalCostUsd, 0) / report.taskResults.length;
    const avgTokens = report.taskResults.reduce((s, r) => s + r.tokenUsage.inputTokens + r.tokenUsage.outputTokens, 0) / report.taskResults.length;

    lines.push(`- **Tasks:** ${report.taskResults.length} (${successCount} passed)`);
    lines.push(`- **Avg turns:** ${avgTurns.toFixed(1)} | **Avg cost:** $${avgCost.toFixed(2)} | **Avg tokens:** ${Math.round(avgTokens).toLocaleString()}`);
    lines.push('');

    lines.push('| # | Type | Title | Result | Turns | Cost | Files | Correctness |');
    lines.push('|---|------|-------|--------|-------|------|-------|-------------|');
    for (let i = 0; i < report.taskResults.length; i++) {
      const r = report.taskResults[i];
      const corrPct = `${Math.round(r.fileOverlapScore * 100)}%`;
      lines.push(`| ${i + 1} | ${r.taskType} | ${r.taskTitle} | ${r.success ? 'Pass' : 'Fail'} | ${r.numTurns} | $${r.totalCostUsd.toFixed(2)} | ${r.filesModified.length} | ${corrPct} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// Formats a single recommendation as a self-contained Markdown task block.
// Each block has: title, current/desired state, files to modify, steps, acceptance criteria,
// and optional draft content (for CLAUDE.md generation).
function formatRecommendation(rec: ExecutableRecommendation, index: number): string {
  const lines: string[] = [];

  lines.push(`### Task ${index}: ${rec.title}`);
  let meta = `**Priority ${rec.priority}** | **Category:** ${rec.category} | **Estimated impact:** +${rec.estimatedScoreImpact} points | **Effort:** ${rec.estimatedEffort}`;
  if (rec.dependsOn && rec.dependsOn.length > 0) {
    meta += ` | **Depends on:** ${rec.dependsOn.join(', ')}`;
  }
  lines.push(meta);
  lines.push('');

  lines.push('#### Current State');
  lines.push(rec.currentState);
  lines.push('');

  lines.push('#### Desired End State');
  lines.push(rec.desiredEndState);
  lines.push('');

  if (rec.filesToModify.length > 0) {
    lines.push('#### Files to Modify');
    for (const f of rec.filesToModify) {
      lines.push(`- \`${f.path}\` — ${f.action}`);
    }
    lines.push('');
  }

  lines.push('#### Implementation Steps');
  for (let i = 0; i < rec.implementationSteps.length; i++) {
    lines.push(`${i + 1}. ${rec.implementationSteps[i]}`);
  }
  lines.push('');

  lines.push('#### Acceptance Criteria');
  for (const c of rec.acceptanceCriteria) {
    lines.push(`- [ ] ${c}`);
  }
  lines.push('');

  if (rec.context) {
    lines.push('#### Context');
    lines.push(rec.context);
    lines.push('');
  }

  if (rec.draftContent) {
    lines.push('#### Draft Content');
    lines.push('```markdown');
    lines.push(rec.draftContent);
    lines.push('```');
    lines.push('');
  }

  return lines.join('\n');
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(0)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

// Grade summary text — used in the report header to give a quick assessment
function getGradeSummary(grade: string): string {
  switch (grade) {
    case 'A': return 'This codebase is highly LLM-friendly. Well-organized structure, good documentation, and clean architecture enable efficient LLM-assisted development.';
    case 'B': return 'This codebase is moderately LLM-friendly. Good foundations with room for improvement in a few areas to maximize LLM efficiency.';
    case 'C': return 'This codebase has average LLM-friendliness. Several areas need improvement to enable efficient LLM-assisted development.';
    case 'D': return 'This codebase has below-average LLM-friendliness. Significant structural and documentation improvements are needed.';
    case 'F': return 'This codebase is not LLM-friendly. Major restructuring and documentation work is needed for effective LLM-assisted development.';
    default: return '';
  }
}
