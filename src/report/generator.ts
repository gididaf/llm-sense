import type { FinalReport, ExecutableRecommendation, CategoryScore, StaticAnalysisResult, CodebaseUnderstanding } from '../types.js';

export function generateReport(report: FinalReport): string {
  const lines: string[] = [];

  // Header
  lines.push(`# LLM-Sense Report: ${report.understanding?.projectName ?? 'Unknown Project'}`);
  lines.push('');
  lines.push(`**Generated:** ${report.generatedAt}`);
  lines.push(`**Target:** \`${report.targetPath}\``);
  lines.push(`**Total cost:** $${report.totalCostUsd.toFixed(2)} | **Duration:** ${formatDuration(report.totalDurationMs)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  // Overall Score with delta
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

  // Category Breakdown Table
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

  // How to Use This Report
  lines.push('## How to Use This Report');
  lines.push('');
  lines.push('> Each task below is **self-contained**. Copy any task and paste it into Claude Code');
  lines.push('> (or feed this report to Ralph) to implement the improvement. Tasks are ordered by impact.');
  lines.push('> Each task can be executed independently in its own session.');
  lines.push('');
  lines.push('---');
  lines.push('');

  // LLM-Executable Recommendations
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

  // Codebase Profile
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

  // Detailed Findings per Category
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

  // Empirical Testing Results
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

    lines.push('| # | Type | Title | Result | Turns | Cost | Files Modified |');
    lines.push('|---|------|-------|--------|-------|------|----------------|');
    for (let i = 0; i < report.taskResults.length; i++) {
      const r = report.taskResults[i];
      lines.push(`| ${i + 1} | ${r.taskType} | ${r.taskTitle} | ${r.success ? 'Pass' : 'Fail'} | ${r.numTurns} | $${r.totalCostUsd.toFixed(2)} | ${r.filesModified.length} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function formatRecommendation(rec: ExecutableRecommendation, index: number): string {
  const lines: string[] = [];

  lines.push(`### Task ${index}: ${rec.title}`);
  lines.push(`**Priority ${rec.priority}** | **Category:** ${rec.category} | **Estimated impact:** +${rec.estimatedScoreImpact} points`);
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

// --- Recommendation builders ---

export function buildExecutableRecommendations(
  categories: CategoryScore[],
  staticAnalysis: StaticAnalysisResult,
  understanding: CodebaseUnderstanding | null,
): ExecutableRecommendation[] {
  const recs: ExecutableRecommendation[] = [];
  let idCounter = 1;

  // 1. CLAUDE.md creation/improvement (highest impact)
  const docCat = categories.find(c => c.name === 'Documentation');
  if (docCat) {
    const hasClaudeMd = staticAnalysis.documentation.hasClaudeMd;
    const content = staticAnalysis.documentation.claudeMdContent;

    if (!hasClaudeMd) {
      const draft = understanding ? generateClaudeMdDraft(understanding, staticAnalysis) : undefined;
      recs.push({
        id: `rec-${idCounter++}`,
        title: 'Create comprehensive CLAUDE.md',
        priority: 1,
        estimatedScoreImpact: 15,
        category: 'Documentation',
        currentState: 'No CLAUDE.md file exists. LLMs have no project-specific orientation when working on this codebase.',
        desiredEndState: 'A CLAUDE.md at the project root with 8 essential sections: Architecture, Module Map, Common Patterns, Testing, Build/Run/Deploy, Gotchas, Tech Stack, and Environment Setup.',
        filesToModify: [{ path: 'CLAUDE.md', action: 'Create new file' }],
        implementationSteps: [
          'Create CLAUDE.md at the project root',
          draft ? 'Use the draft content below as a starting point' : 'Add sections for: Architecture Overview, Module Map, Common Patterns, Testing, Build/Run/Deploy, Gotchas, Tech Stack, Environment Setup',
          'Review and adjust any inaccuracies based on your knowledge of the project',
          'Add specific examples for "Common Patterns" (e.g., how to add a new API endpoint)',
        ],
        acceptanceCriteria: [
          'CLAUDE.md exists at project root',
          'Contains Architecture Overview section',
          'Contains Module Map or component dependency description',
          'Contains at least one "how to add X" common pattern example',
          'Contains build/run/deploy commands',
          'Contains tech stack with version info',
        ],
        context: 'CLAUDE.md is the single highest-impact file for LLM-friendliness. It provides the LLM with project-specific orientation that drastically reduces wasted tokens exploring the codebase.',
        draftContent: draft,
      });
    } else if (content && content.missingSections.length > 0) {
      recs.push({
        id: `rec-${idCounter++}`,
        title: `Add ${content.missingSections.length} missing sections to CLAUDE.md`,
        priority: 1,
        estimatedScoreImpact: Math.min(content.missingSections.length * 3, 12),
        category: 'Documentation',
        currentState: `CLAUDE.md exists (${staticAnalysis.documentation.claudeMdLines} lines) but is missing: ${content.missingSections.join(', ')}.`,
        desiredEndState: `CLAUDE.md covers all 8 essential sections: Architecture, Module Map, Common Patterns, Testing, Build/Run/Deploy, Gotchas, Tech Stack, Environment Setup.`,
        filesToModify: [{ path: 'CLAUDE.md', action: 'Add missing sections' }],
        implementationSteps: content.missingSections.map(s =>
          `Add a "## ${s}" section with relevant content for this project`,
        ),
        acceptanceCriteria: content.missingSections.map(s =>
          `CLAUDE.md contains a "${s}" section with meaningful content`,
        ),
        context: `The existing CLAUDE.md covers ${8 - content.missingSections.length}/8 recommended sections. Adding the missing sections will improve the Documentation score significantly.`,
      });
    }

    // README recommendation
    if (!staticAnalysis.documentation.hasReadme) {
      recs.push({
        id: `rec-${idCounter++}`,
        title: 'Add README.md',
        priority: 2,
        estimatedScoreImpact: 3,
        category: 'Documentation',
        currentState: 'No README.md exists.',
        desiredEndState: 'A README.md with project overview, setup instructions, and contribution guide.',
        filesToModify: [{ path: 'README.md', action: 'Create new file' }],
        implementationSteps: [
          'Create README.md at the project root',
          'Add project name and one-line description',
          'Add setup/installation instructions',
          'Add basic usage examples',
        ],
        acceptanceCriteria: [
          'README.md exists at project root',
          'Contains project description',
          'Contains setup instructions',
        ],
        context: 'README.md provides basic project orientation for both humans and LLMs.',
      });
    }
  }

  // 2. File size recommendations (split large files)
  const fileSizeCat = categories.find(c => c.name === 'File Sizes');
  if (fileSizeCat && staticAnalysis.fileSizes.largestFiles.length > 0) {
    const godFiles = staticAnalysis.fileSizes.largestFiles.filter(f => f.lines > 800);
    for (const file of godFiles.slice(0, 5)) {
      recs.push({
        id: `rec-${idCounter++}`,
        title: `Split ${file.path} (${file.lines.toLocaleString()} lines)`,
        priority: file.lines > 2000 ? 1 : 2,
        estimatedScoreImpact: file.lines > 2000 ? 5 : 2,
        category: 'File Sizes',
        currentState: `\`${file.path}\` is ${file.lines.toLocaleString()} lines long. Files this large overwhelm LLM context windows and make it harder to isolate relevant code.`,
        desiredEndState: `The file is split into multiple focused modules, each under 300 lines, with clear single responsibilities.`,
        filesToModify: [
          { path: file.path, action: 'Split into multiple smaller files' },
        ],
        implementationSteps: [
          `Read \`${file.path}\` and identify logical groupings of functions/classes`,
          'Create new files for each group (e.g., by domain, by feature, by type)',
          'Move functions/classes to their new files',
          'Update imports in all consuming files',
          'Optionally create a barrel export (index.ts) to maintain backward compatibility',
        ],
        acceptanceCriteria: [
          `\`${file.path}\` is either removed or reduced to under 300 lines`,
          'All new files are under 300 lines',
          'No broken imports or references',
          'Existing functionality is preserved',
        ],
        context: `Large files force LLMs to load excessive context. Splitting into focused modules means the LLM only loads what it needs for a given task.`,
      });
    }
  }

  // 3. Naming consistency
  const namingCat = categories.find(c => c.name === 'Naming');
  if (namingCat && staticAnalysis.naming.conventionScore < 70 && staticAnalysis.naming.inconsistencies.length > 0) {
    recs.push({
      id: `rec-${idCounter++}`,
      title: `Standardize file naming to ${staticAnalysis.naming.dominantConvention}`,
      priority: 3,
      estimatedScoreImpact: 2,
      category: 'Naming',
      currentState: `File naming is ${staticAnalysis.naming.conventionScore}% consistent with ${staticAnalysis.naming.dominantConvention} convention. ${staticAnalysis.naming.inconsistencies.length} files use different conventions.`,
      desiredEndState: `All source files follow ${staticAnalysis.naming.dominantConvention} naming convention.`,
      filesToModify: staticAnalysis.naming.inconsistencies.slice(0, 10).map(inc => ({
        path: inc.split(' ')[0],
        action: `Rename to ${staticAnalysis.naming.dominantConvention}`,
      })),
      implementationSteps: [
        `Identify files not using ${staticAnalysis.naming.dominantConvention}`,
        'Rename each file to follow the convention',
        'Update all import paths referencing the renamed files',
      ],
      acceptanceCriteria: [
        `All renamed files follow ${staticAnalysis.naming.dominantConvention} convention`,
        'No broken imports',
      ],
      context: 'Consistent naming helps LLMs predict file locations and reduces exploration time.',
    });
  }

  // 4. Modularity improvements
  const modCat = categories.find(c => c.name === 'Modularity');
  if (modCat && staticAnalysis.modularity.maxFilesInDirectory.count > 20) {
    const dir = staticAnalysis.modularity.maxFilesInDirectory;
    recs.push({
      id: `rec-${idCounter++}`,
      title: `Split \`${dir.path}\` directory (${dir.count} files)`,
      priority: 2,
      estimatedScoreImpact: 3,
      category: 'Modularity',
      currentState: `\`${dir.path}\` contains ${dir.count} files, making it hard for LLMs to find relevant code.`,
      desiredEndState: `Files are organized into sub-directories by domain or feature, each with 5-15 files.`,
      filesToModify: [{ path: dir.path, action: 'Reorganize into sub-directories' }],
      implementationSteps: [
        `Review files in \`${dir.path}\` and identify logical groupings`,
        'Create sub-directories for each group',
        'Move files to their new sub-directories',
        'Update all import paths',
      ],
      acceptanceCriteria: [
        `\`${dir.path}\` has fewer than 15 direct files`,
        'Sub-directories are organized by domain or feature',
        'No broken imports',
      ],
      context: 'Directories with many files are hard for LLMs to navigate. Grouping into sub-directories makes the structure self-documenting.',
    });
  }

  // 5. Context efficiency (noise)
  const ctxCat = categories.find(c => c.name === 'Context Efficiency');
  if (ctxCat && staticAnalysis.noise.lockfileBytes > 500_000) {
    recs.push({
      id: `rec-${idCounter++}`,
      title: 'Configure LLM context exclusions for large lockfiles',
      priority: 3,
      estimatedScoreImpact: 2,
      category: 'Context Efficiency',
      currentState: `Large lockfiles (${Math.round(staticAnalysis.noise.lockfileBytes / 1024)}KB) are included in the project and may be loaded into LLM context.`,
      desiredEndState: 'CLAUDE.md or .cursorrules instructs LLMs to ignore lockfiles and generated files.',
      filesToModify: [{ path: 'CLAUDE.md', action: 'Add context exclusion guidance' }],
      implementationSteps: [
        'Add a section to CLAUDE.md listing files/directories to skip',
        'Include: lockfiles, generated files, binary assets, node_modules',
      ],
      acceptanceCriteria: [
        'CLAUDE.md contains guidance about which files to skip',
      ],
      context: 'Lockfiles waste tokens when loaded into context. Explicit exclusion guidance prevents this.',
    });
  }

  // Sort by priority, then by estimated impact
  recs.sort((a, b) => a.priority - b.priority || b.estimatedScoreImpact - a.estimatedScoreImpact);

  return recs;
}

export function generateClaudeMdDraft(
  understanding: CodebaseUnderstanding,
  staticAnalysis: StaticAnalysisResult,
): string {
  const lines: string[] = [];

  lines.push(`# ${understanding.projectName}`);
  lines.push('');

  // Architecture Overview
  lines.push('## Architecture Overview');
  lines.push('');
  lines.push(understanding.description);
  lines.push('');
  lines.push(`**Pattern:** ${understanding.architecture.pattern}`);
  lines.push('');
  if (understanding.architecture.dataFlow) {
    lines.push(`**Data Flow:** ${understanding.architecture.dataFlow}`);
    lines.push('');
  }
  lines.push(`**Complexity:** ${understanding.complexity}`);
  lines.push('');

  // Tech Stack
  lines.push('## Tech Stack');
  lines.push('');
  const byCategory = new Map<string, string[]>();
  for (const tech of understanding.techStack) {
    const list = byCategory.get(tech.category) ?? [];
    list.push(`${tech.name} — ${tech.role}`);
    byCategory.set(tech.category, list);
  }
  for (const [category, techs] of byCategory) {
    lines.push(`**${category}:**`);
    for (const t of techs) {
      lines.push(`- ${t}`);
    }
    lines.push('');
  }

  // Module Map
  lines.push('## Module Map');
  lines.push('');
  lines.push('**Entry Points:**');
  for (const ep of understanding.architecture.entryPoints) {
    lines.push(`- ${ep}`);
  }
  lines.push('');
  if (understanding.architecture.keyAbstractions.length > 0) {
    lines.push('**Key Abstractions:**');
    for (const abs of understanding.architecture.keyAbstractions) {
      lines.push(`- ${abs}`);
    }
    lines.push('');
  }

  // Common Patterns
  lines.push('## Common Patterns');
  lines.push('');
  lines.push(`**Code Organization:** ${understanding.conventions.codeOrganization}`);
  lines.push('');
  lines.push(`**Error Handling:** ${understanding.conventions.errorHandling}`);
  lines.push('');
  if (understanding.conventions.stateManagement) {
    lines.push(`**State Management:** ${understanding.conventions.stateManagement}`);
    lines.push('');
  }

  // Testing
  lines.push('## Testing');
  lines.push('');
  lines.push(understanding.conventions.testingApproach);
  lines.push('');

  // Build/Run/Deploy
  lines.push('## Build / Run / Deploy');
  lines.push('');
  lines.push('<!-- TODO: Add specific commands for building, running, and deploying -->');
  lines.push('');

  // Gotchas
  const concerns = understanding.llmFriendlinessNotes.filter(n =>
    n.toLowerCase().includes('concern') || n.toLowerCase().includes('caveat') || n.toLowerCase().includes('warning'),
  );
  if (concerns.length > 0) {
    lines.push('## Gotchas');
    lines.push('');
    for (const c of concerns) {
      lines.push(`- ${c}`);
    }
    lines.push('');
  }

  // Environment Setup
  lines.push('## Environment Setup');
  lines.push('');
  lines.push('<!-- TODO: Add environment setup instructions, required env vars, etc. -->');
  lines.push('');

  return lines.join('\n');
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(0)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

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
