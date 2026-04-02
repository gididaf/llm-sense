import type { ExecutableRecommendation, CategoryScore, StaticAnalysisResult, CodebaseUnderstanding } from '../types.js';

// Transforms category scores and static analysis findings into self-contained
// executable recommendations. Each recommendation includes enough context for
// an LLM to implement the improvement without additional information.
// Output is sorted by priority (1=highest) then by estimated score impact.
export function buildExecutableRecommendations(
  categories: CategoryScore[],
  staticAnalysis: StaticAnalysisResult,
  understanding: CodebaseUnderstanding | null,
): ExecutableRecommendation[] {
  const recs: ExecutableRecommendation[] = [];
  let idCounter = 1;

  // Documentation recommendations come first — CLAUDE.md is the single highest-impact change
  const docCat = categories.find(c => c.name === 'Documentation');
  if (docCat) {
    const hasClaudeMd = staticAnalysis.documentation.hasClaudeMd;
    const content = staticAnalysis.documentation.claudeMdContent;

    if (!hasClaudeMd) {
      // No CLAUDE.md at all — generate a complete draft if we have LLM understanding
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
      // CLAUDE.md exists but is missing some sections
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

    // Low inline comment ratio — suggest adding comments to complex functions
    if (staticAnalysis.documentation.inlineCommentRatio < 0.05) {
      recs.push({
        id: `rec-${idCounter++}`,
        title: 'Add inline comments to complex functions',
        priority: 3,
        estimatedScoreImpact: 2,
        category: 'Documentation',
        currentState: `Inline comment ratio is ${(staticAnalysis.documentation.inlineCommentRatio * 100).toFixed(1)}%. LLMs benefit from comments that explain non-obvious logic, scoring formulas, and architectural decisions.`,
        desiredEndState: 'Key functions have comments explaining their purpose, non-obvious logic, and any gotchas. Target ~5-10% comment ratio.',
        filesToModify: [{ path: 'src/', action: 'Add comments to complex functions' }],
        implementationSteps: [
          'Identify functions with complex logic, scoring formulas, or non-obvious behavior',
          'Add a brief comment above each explaining what it does and why',
          'Add inline comments for tricky conditionals or magic numbers',
          'Do NOT add obvious comments like "// increment counter" — focus on the "why"',
        ],
        acceptanceCriteria: [
          'Complex functions have explanatory comments',
          'No obvious or redundant comments added',
        ],
        context: 'Inline comments help LLMs understand intent, not just syntax. A well-commented function is solved in fewer turns because the LLM doesn\'t need to reverse-engineer the logic.',
      });
    }

    // README recommendation if missing
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

  // File size recommendations — flag files that are large enough to hurt LLM context efficiency.
  // 500+ lines gets a suggestion, 2000+ gets priority 1.
  const fileSizeCat = categories.find(c => c.name === 'File Sizes');
  if (fileSizeCat && staticAnalysis.fileSizes.largestFiles.length > 0) {
    const largeFiles = staticAnalysis.fileSizes.largestFiles.filter(f => f.lines > 500);
    for (const file of largeFiles.slice(0, 5)) {
      recs.push({
        id: `rec-${idCounter++}`,
        title: `Split ${file.path} (${file.lines.toLocaleString()} lines)`,
        priority: file.lines > 2000 ? 1 : file.lines > 800 ? 2 : 3,
        estimatedScoreImpact: file.lines > 2000 ? 5 : file.lines > 800 ? 2 : 1,
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

  // Naming consistency — inconsistent naming forces LLMs to explore instead of predict.
  // Threshold is 90% — even a few inconsistencies are worth fixing since they're easy wins.
  const namingCat = categories.find(c => c.name === 'Naming');
  if (namingCat && staticAnalysis.naming.conventionScore < 90 && staticAnalysis.naming.inconsistencies.length > 0) {
    const impact = staticAnalysis.naming.conventionScore < 70 ? 3 : 1;
    recs.push({
      id: `rec-${idCounter++}`,
      title: `Standardize file naming to ${staticAnalysis.naming.dominantConvention}`,
      priority: staticAnalysis.naming.conventionScore < 70 ? 2 : 3,
      estimatedScoreImpact: impact,
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

  // Modularity — directories with too many files are hard for LLMs to navigate
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

  // Single-file directories — a directory with just 1 file adds navigation overhead
  // without organizational benefit. Suggest merging into parent or expanding the module.
  if (modCat && staticAnalysis.modularity.singleFileDirectories > 0) {
    const ratio = staticAnalysis.modularity.totalDirectories > 0
      ? staticAnalysis.modularity.singleFileDirectories / staticAnalysis.modularity.totalDirectories
      : 0;
    if (ratio > 0.2 || staticAnalysis.modularity.singleFileDirectories >= 3) {
      recs.push({
        id: `rec-${idCounter++}`,
        title: `Consolidate ${staticAnalysis.modularity.singleFileDirectories} single-file directories`,
        priority: 3,
        estimatedScoreImpact: 2,
        category: 'Modularity',
        currentState: `${staticAnalysis.modularity.singleFileDirectories} directories contain only 1 file. Single-file directories add navigation depth without organizational benefit — LLMs must enter the directory only to find one file.`,
        desiredEndState: 'Each directory contains 2+ related files, or single files are moved to their parent directory.',
        filesToModify: [{ path: '.', action: 'Reorganize single-file directories' }],
        implementationSteps: [
          'Identify directories containing only 1 source file',
          'For each: either move the file to its parent directory, or add related files to justify the directory',
          'Update all import paths referencing moved files',
        ],
        acceptanceCriteria: [
          'No directories contain only 1 source file (or clear justification exists)',
          'No broken imports',
        ],
        context: 'Single-file directories force LLMs to navigate deeper without gaining organizational clarity. Consolidating them reduces the number of tool calls needed to explore the codebase.',
      });
    }
  }

  // Context efficiency — large lockfiles waste tokens when accidentally loaded
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

  // Sort by priority (highest first), then by estimated impact (highest first)
  recs.sort((a, b) => a.priority - b.priority || b.estimatedScoreImpact - a.estimatedScoreImpact);

  return recs;
}

// Generates a complete CLAUDE.md from Phase 2 understanding data.
// Only called when empirical mode runs (needs LLM understanding) and the target
// codebase is missing a CLAUDE.md. The draft is included in the recommendation
// so the user can review and adopt it directly.
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

  // Tech Stack — grouped by category for readability
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

  // Module Map — entry points and key abstractions from LLM understanding
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

  // Build/Run/Deploy — TODO placeholder since LLM understanding doesn't always capture commands
  lines.push('## Build / Run / Deploy');
  lines.push('');
  lines.push('<!-- TODO: Add specific commands for building, running, and deploying -->');
  lines.push('');

  // Gotchas — extracted from LLM friendliness notes that mention concerns/caveats
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
