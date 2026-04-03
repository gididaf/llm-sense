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

  // How to Use — instructions for copy-pasting tasks into Claude Code or Ralph
  lines.push('## How to Use This Report');
  lines.push('');
  lines.push('> Each task below is **self-contained**. Copy any task and paste it into Claude Code');
  lines.push('> (or feed this report to Ralph) to implement the improvement. Tasks are ordered by impact.');
  lines.push('> Each task can be executed independently in its own session.');
  lines.push('');
  lines.push('---');
  lines.push('');

  // LLM-Executable Improvement Tasks
  if (report.recommendations.length > 0) {
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
