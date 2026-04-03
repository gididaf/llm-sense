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
  // Data files and vendored files get different recommendations than code files.
  const fileSizeCat = categories.find(c => c.name === 'File Sizes');
  if (fileSizeCat && staticAnalysis.fileSizes.largestFiles.length > 0) {
    const largeFiles = staticAnalysis.fileSizes.largestFiles.filter(f => f.lines > 500);
    for (const file of largeFiles.slice(0, 5)) {
      if (file.classification === 'vendored') {
        // Vendored/third-party file — recommend exclusion, not splitting
        recs.push({
          id: `rec-${idCounter++}`,
          title: `Exclude vendored file ${file.path} (${file.lines.toLocaleString()} lines)`,
          priority: file.lines > 2000 ? 1 : 2,
          estimatedScoreImpact: file.lines > 2000 ? 5 : 2,
          category: 'File Sizes',
          currentState: `\`${file.path}\` is a ${file.lines.toLocaleString()}-line vendored/third-party file. It inflates file size metrics and wastes LLM context if loaded.`,
          desiredEndState: 'The vendored file is either replaced with a package dependency, moved to a vendored directory excluded from LLM context, or listed in CLAUDE.md as a file to skip.',
          filesToModify: [
            { path: file.path, action: 'Replace with npm/package dependency or exclude from LLM context' },
          ],
          implementationSteps: [
            `Check if \`${file.path}\` can be replaced with an npm package (check for the library name and version in the file header)`,
            'If replaceable: install the package via npm/pnpm and update imports',
            'If not replaceable: add the file path to CLAUDE.md under a "Files to Skip" section',
            'Optionally add the file to .gitattributes with linguist-vendored=true',
          ],
          acceptanceCriteria: [
            'The vendored file is either replaced with a proper dependency or excluded from LLM context',
            'No broken imports or references',
          ],
          context: 'Vendored third-party files should not be modified by LLMs. Excluding them from context saves tokens and prevents the tool from recommending changes to code you don\'t own.',
        });
      } else if (file.classification === 'data') {
        // Data file — recommend extraction or exclusion, not splitting into "modules"
        recs.push({
          id: `rec-${idCounter++}`,
          title: `Extract or exclude data file ${file.path} (${file.lines.toLocaleString()} lines)`,
          priority: file.lines > 2000 ? 1 : 2,
          estimatedScoreImpact: file.lines > 2000 ? 5 : 2,
          category: 'File Sizes',
          currentState: `\`${file.path}\` is a ${file.lines.toLocaleString()}-line static data file. It inflates file size metrics and wastes LLM context since it contains data, not logic.`,
          desiredEndState: 'The data is either moved to a JSON/CSV file (excluded from LLM context) or the file is listed in CLAUDE.md as a data file to skip.',
          filesToModify: [
            { path: file.path, action: 'Move data to JSON or exclude from LLM context' },
          ],
          implementationSteps: [
            `Read \`${file.path}\` and confirm it is primarily static data (object literals, arrays, constants)`,
            'If possible: extract the data to a .json file and import it at runtime',
            'If the data must remain in code: add the file path to CLAUDE.md under a "Files to Skip" section so LLMs know not to load it',
            'Add a brief comment at the top of the file explaining what data it contains',
          ],
          acceptanceCriteria: [
            'The data is in a JSON file or the source file is documented as a data file in CLAUDE.md',
            'No broken imports or references',
          ],
          context: 'Large data files (static mappings, seed data, constants) waste LLM context tokens without providing useful logic context. Moving data to JSON or excluding from LLM context keeps the focus on actual code.',
        });
      } else {
        // Code file — use test-specific or generic advice depending on file type
        const isTestFile = /\.(test|spec)\.(ts|tsx|js|jsx)$/.test(file.path) || /\btests?\b/.test(file.path);

        if (isTestFile) {
          recs.push({
            id: `rec-${idCounter++}`,
            title: `Split ${file.path} (${file.lines.toLocaleString()} lines)`,
            priority: file.lines > 2000 ? 1 : file.lines > 800 ? 2 : 3,
            estimatedScoreImpact: file.lines > 2000 ? 5 : file.lines > 800 ? 2 : 1,
            category: 'File Sizes',
            currentState: `\`${file.path}\` is a ${file.lines.toLocaleString()}-line test file. Large test files are hard for LLMs to navigate when debugging failures or adding new test cases.`,
            desiredEndState: `The test file is split into multiple focused test files, each under 500 lines, grouped by feature or test category.`,
            filesToModify: [
              { path: file.path, action: 'Split into multiple focused test files' },
            ],
            implementationSteps: [
              `Read \`${file.path}\` and identify the top-level describe blocks or test groups`,
              'Create a new test file for each major group (e.g., by feature area, by permission type, by CRUD operation)',
              'Move each describe block and its associated setup/teardown to the new file',
              'Ensure shared test fixtures or helpers are extracted to a shared test utils file',
              'Verify all tests still pass after splitting',
            ],
            acceptanceCriteria: [
              `\`${file.path}\` is either removed or reduced to under 500 lines`,
              'Each new test file covers a specific feature area or test category',
              'All tests pass with the same results as before',
              'Shared test setup is in a dedicated helper file',
            ],
            context: 'Large test files make it hard for LLMs to find relevant test cases and understand test organization. Splitting by feature area means the LLM can load just the tests relevant to the code being changed.',
          });
        } else {
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
    }
  }

  // Naming consistency — inconsistent naming forces LLMs to explore instead of predict.
  // Threshold is 90% — even a few inconsistencies are worth fixing since they're easy wins.
  // Inconsistencies are per-directory (each file shows its expected convention for its group).
  const namingCat = categories.find(c => c.name === 'Naming');
  if (namingCat && staticAnalysis.naming.conventionScore < 90 && staticAnalysis.naming.inconsistencies.length > 0) {
    const impact = staticAnalysis.naming.conventionScore < 70 ? 3 : 1;
    recs.push({
      id: `rec-${idCounter++}`,
      title: `Fix ${staticAnalysis.naming.inconsistencies.length} file naming inconsistencies`,
      priority: staticAnalysis.naming.conventionScore < 70 ? 2 : 3,
      estimatedScoreImpact: impact,
      category: 'Naming',
      currentState: `File naming is ${staticAnalysis.naming.conventionScore}% consistent within each directory group. ${staticAnalysis.naming.inconsistencies.length} files don't match their directory's convention.`,
      desiredEndState: 'Each file follows the naming convention of its directory group.',
      filesToModify: staticAnalysis.naming.inconsistencies.slice(0, 10).map(inc => {
        // Extract expected convention from the inconsistency string: "file.ts uses X (expected Y in dir/)"
        const expectedMatch = inc.match(/\(expected (.+?) in /);
        const expected = expectedMatch ? expectedMatch[1] : staticAnalysis.naming.dominantConvention;
        return {
          path: inc.split(' ')[0],
          action: `Rename to ${expected}`,
        };
      }),
      implementationSteps: [
        'For each file listed above, rename to match its directory\'s convention',
        'Update all import paths referencing the renamed files',
        'Note: different directories may use different conventions (e.g., PascalCase for React components, kebab-case for backend utils) — this is intentional',
      ],
      acceptanceCriteria: [
        'All renamed files follow their directory\'s convention',
        'No broken imports',
      ],
      context: 'Consistent naming within each directory group helps LLMs predict file locations. Different areas of a codebase may legitimately use different conventions (e.g., PascalCase for components, kebab-case for backend).',
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
  // without organizational benefit. HOWEVER: skip this recommendation if the project
  // documents a modular architecture (e.g., "modular monolith", "each module is self-contained")
  // since single-file dirs are often intentional in modular structures.
  if (modCat && staticAnalysis.modularity.singleFileDirectories > 0) {
    const ratio = staticAnalysis.modularity.totalDirectories > 0
      ? staticAnalysis.modularity.singleFileDirectories / staticAnalysis.modularity.totalDirectories
      : 0;

    // Check if CLAUDE.md describes an intentional modular architecture
    const claudeMdRaw = staticAnalysis.documentation.claudeMdContent?.rawContent ?? '';
    const hasModularArchitecture = /\b(modular\s+monolith|self-contained\s+module|each\s+module\s+(is|has)|module.based|feature.based\s+(structure|architecture|organization))\b/i.test(claudeMdRaw);
    // Also check if barrel exports are widespread (suggests intentional module structure)
    const hasStrongBarrelPattern = staticAnalysis.modularity.barrelExportCount > 20;

    const isIntentionallyModular = hasModularArchitecture || (hasStrongBarrelPattern && ratio > 0.3);

    if (!isIntentionallyModular && (ratio > 0.2 || staticAnalysis.modularity.singleFileDirectories >= 3)) {
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

  // Assign effort estimates and dependencies
  for (const rec of recs) {
    rec.estimatedEffort = estimateEffort(rec);
    rec.dependsOn = findDependencies(rec, recs);
  }

  // Sort by priority (highest first), then by estimated impact (highest first)
  recs.sort((a, b) => a.priority - b.priority || b.estimatedScoreImpact - a.estimatedScoreImpact);

  return recs;
}

function estimateEffort(rec: ExecutableRecommendation): ExecutableRecommendation['estimatedEffort'] {
  // Documentation tasks: creating files is quick, splitting code is harder
  if (rec.title.includes('Create comprehensive CLAUDE.md')) return '30min';
  if (rec.title.includes('Add README.md')) return '5min';
  if (rec.title.includes('missing sections')) return '30min';
  if (rec.title.includes('inline comments')) return '2hr';
  if (rec.title.includes('Configure LLM context exclusions')) return '5min';
  if (rec.title.includes('naming inconsistencies')) return '30min';

  // File splitting tasks scale with file size and complexity
  if (rec.title.startsWith('Split')) {
    if (rec.estimatedScoreImpact >= 5) return 'half-day';
    if (rec.estimatedScoreImpact >= 2) return '2hr';
    return '30min';
  }

  // Vendored/data file tasks are quick
  if (rec.title.includes('vendored') || rec.title.includes('Exclude')) return '30min';
  if (rec.title.includes('Extract or exclude data')) return '30min';

  // Directory reorganization
  if (rec.title.includes('directory')) return '2hr';
  if (rec.title.includes('Consolidate')) return '2hr';

  return '30min';
}

function findDependencies(
  rec: ExecutableRecommendation,
  allRecs: ExecutableRecommendation[],
): string[] | undefined {
  const deps: string[] = [];

  // "Configure LLM context exclusions" depends on having a CLAUDE.md
  if (rec.title.includes('Configure LLM context exclusions')) {
    const claudeMdRec = allRecs.find(r => r.title.includes('Create comprehensive CLAUDE.md'));
    if (claudeMdRec) deps.push(claudeMdRec.id);
  }

  // Adding inline comments should come after file splits (so you comment the right files)
  if (rec.title.includes('inline comments')) {
    const splits = allRecs.filter(r => r.title.startsWith('Split'));
    if (splits.length > 0) deps.push(...splits.map(s => s.id));
  }

  return deps.length > 0 ? deps : undefined;
}

// Generates a progressive improvement plan: recommendations sorted by ROI
// with cumulative projected scores. Designed for quick scanning.
export function generatePlan(
  recommendations: ExecutableRecommendation[],
  currentScore: number,
  targetPath: string,
): string {
  if (recommendations.length === 0) {
    return '  No recommendations — the codebase looks good!';
  }

  // Sort by estimated impact descending (ROI order)
  const sorted = [...recommendations].sort((a, b) => b.estimatedScoreImpact - a.estimatedScoreImpact);

  const lines: string[] = [];
  const projectName = targetPath.split('/').pop() ?? targetPath;
  lines.push('');
  lines.push(`  Improvement Plan for ${projectName} (Current: ${currentScore}/100)`);
  lines.push('');
  lines.push('  Step  Action                                            Impact  Projected');
  lines.push('  ' + '─'.repeat(74));

  let projected = currentScore;
  for (let i = 0; i < sorted.length; i++) {
    const rec = sorted[i];
    projected = Math.min(100, projected + rec.estimatedScoreImpact);
    const step = String(i + 1).padStart(2);
    const action = rec.title.length > 50 ? rec.title.slice(0, 47) + '...' : rec.title;
    const impact = `+${rec.estimatedScoreImpact}`;
    lines.push(`  ${step}.   ${action.padEnd(50)}  ${impact.padStart(4)}    ${projected}/100`);
  }

  lines.push('  ' + '─'.repeat(74));
  lines.push(`  Projected final score: ${projected}/100 (+${projected - currentScore} from current)`);
  lines.push('');
  lines.push('  Note: Projected scores are additive estimates; actual results may vary');
  lines.push('  due to interaction effects between changes.');
  lines.push('');
  lines.push('  Run `llm-sense --fix --fix-id <rec-id>` to apply a specific recommendation.');
  lines.push('');

  return lines.join('\n');
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
