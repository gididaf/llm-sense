import { callClaudeStructured, callClaudeWithRetry } from '../core/claude.js';
import { readFileSafe, getSourceFiles, stratifiedSample, buildDirectorySummary, type WalkEntry } from '../core/fs.js';
import { TaskGenerationResponseSchema, type TaskGenerationResponse, type CodebaseUnderstanding, type StaticAnalysisResult } from '../types.js';
import { DIFFICULTY_DISTRIBUTION } from '../constants.js';

export async function runTaskGeneration(
  targetPath: string,
  entries: WalkEntry[],
  understanding: CodebaseUnderstanding,
  staticResult: StaticAnalysisResult,
  bugCount: number,
  featureCount: number,
  verbose: boolean,
  model?: string,
): Promise<{ data: TaskGenerationResponse; costUsd: number; durationMs: number }> {
  if (verbose) console.log('  Building prompt for task generation...');

  const sourceFiles = getSourceFiles(entries);

  // Build directory overview (shows every directory with file counts)
  const dirSummary = buildDirectorySummary(sourceFiles);
  const dirCount = dirSummary.split('\n').length;

  // Scale sample count by repo size for better coverage
  const sampleCount = sourceFiles.length < 50 ? Math.min(8, sourceFiles.length)
    : sourceFiles.length < 200 ? 10
    : sourceFiles.length < 500 ? 12
    : 15;

  // Use stratified sampling to cover all areas of the codebase
  const sampled = stratifiedSample(sourceFiles, sampleCount);
  const sampledFiles: string[] = [];

  for (const file of sampled) {
    const content = await readFileSafe(file.path, 8000);
    if (content) {
      const lines = content.split('\n').slice(0, 150).join('\n');
      sampledFiles.push(`--- ${file.relativePath} ---\n${lines}`);
    }
  }

  const minDirSpan = Math.min(5, dirCount);
  const structuralContext = buildStructuralContext(staticResult);
  const bugQuotas = computeDifficultyQuotas(bugCount);
  const featureQuotas = computeDifficultyQuotas(featureCount);

  const prompt = `You are generating synthetic development tasks for a codebase to test how easily an LLM can work with it.

CODEBASE UNDERSTANDING:
- Project: ${understanding.projectName}
- Description: ${understanding.description}
- Tech Stack: ${understanding.techStack.map(t => `${t.name} (${t.category})`).join(', ')}
- Architecture: ${understanding.architecture.pattern}
- Entry Points: ${understanding.architecture.entryPoints.join(', ')}
- Complexity: ${understanding.complexity}
- Code Organization: ${understanding.conventions.codeOrganization}

STRUCTURAL CONTEXT (from static analysis):
${structuralContext}

DIRECTORY OVERVIEW (${sourceFiles.length} source files across ${dirCount} directories):
${dirSummary}

CODE SAMPLES (${sampledFiles.length} representative files from different areas):
${sampledFiles.join('\n\n')}

Generate exactly ${bugCount} synthetic bug tasks and ${featureCount} synthetic feature tasks.

DIFFICULTY DISTRIBUTION (STRICT — you MUST follow these exact counts):
Bugs: ${bugQuotas.easy} easy, ${bugQuotas.medium} medium, ${bugQuotas.hard} hard
Features: ${featureQuotas.easy} easy, ${featureQuotas.medium} medium, ${featureQuotas.hard} hard

Difficulty criteria:
- EASY: Single file change in an isolated/simple module. Target files with low fan-in, low complexity. The fix/feature should be localized and self-contained.
- MEDIUM: 2-3 files within one module or directory. Moderate complexity areas. May involve updating a function and its callers within the same directory.
- HARD: Cross-module changes touching hub files or high-complexity areas. Should require understanding dependency chains and modifying 3+ files across multiple directories. Use the hub files and complexity hotspots from STRUCTURAL CONTEXT above.

RULES:
- Tasks MUST span at least ${minDirSpan} different directories — do NOT cluster tasks in one area
- Bug tasks should describe realistic, plausible bugs (NOT actual bugs in the code, but scenarios like "the pagination is off by one" or "error handling missing in X")
- Feature tasks should be reasonable additions (NOT massive rewrites)
- Each task must have clear acceptance criteria
- Each task should reference specific files that would likely need modification
- Task IDs should be "bug-1", "bug-2", etc. and "feat-1", "feat-2", etc.
- Do NOT generate tasks that require installing new dependencies or running builds
- Tasks should be solvable by reading and modifying existing code files

The quality of these tasks matters — they will be used to empirically measure how LLM-friendly this codebase is.`;

  if (verbose) console.log('  Calling Claude for task generation...');

  const { data, result } = await callClaudeWithRetry(
    () => callClaudeStructured(
      { prompt, cwd: targetPath, timeout: 120_000, model, tools: '', bare: false },
      TaskGenerationResponseSchema,
    ),
  );

  // Post-generation validation: fix difficulty distribution if LLM deviated
  correctDifficultyQuotas(data.bugs, bugQuotas);
  correctDifficultyQuotas(data.features, featureQuotas);

  return {
    data,
    costUsd: result.costUsd,
    durationMs: result.durationMs,
  };
}

function buildStructuralContext(staticResult: StaticAnalysisResult): string {
  const sections: string[] = [];

  // Hub files (high fan-in)
  if (staticResult.imports.hubFiles.length > 0) {
    const hubs = staticResult.imports.hubFiles.slice(0, 5);
    sections.push('Hub Files (high fan-in — changes here affect many dependents):');
    for (const h of hubs) {
      sections.push(`  - ${h.path} (fan-in: ${h.fanIn})`);
    }
  }

  // Complexity hotspots from AST analysis
  if (staticResult.astAnalysis?.functions && staticResult.astAnalysis.functions.length > 0) {
    const sorted = [...staticResult.astAnalysis.functions]
      .sort((a, b) => b.cyclomaticComplexity - a.cyclomaticComplexity)
      .slice(0, 5);
    sections.push('Complexity Hotspots (highest cyclomatic complexity — good targets for hard tasks):');
    for (const f of sorted) {
      sections.push(`  - ${f.name} in ${f.file} (complexity: ${f.cyclomaticComplexity}, ${f.lineCount} lines)`);
    }
  }

  // Isolated/simple files (good for easy tasks)
  if (staticResult.imports.orphanFiles.length > 0) {
    const orphans = staticResult.imports.orphanFiles.slice(0, 5);
    sections.push('Isolated Files (low coupling — good targets for easy tasks):');
    for (const o of orphans) {
      sections.push(`  - ${o}`);
    }
  }

  // Cross-directory coupling from import graph
  if (staticResult.importGraph && staticResult.importGraph.length > 0) {
    const crossDirEdges = new Map<string, number>();
    for (const edge of staticResult.importGraph) {
      const srcDir = edge.source.split('/')[0] || edge.source;
      const tgtDir = edge.target.split('/')[0] || edge.target;
      if (srcDir !== tgtDir) {
        const key = `${srcDir} → ${tgtDir}`;
        crossDirEdges.set(key, (crossDirEdges.get(key) ?? 0) + 1);
      }
    }
    if (crossDirEdges.size > 0) {
      const sorted = [...crossDirEdges.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
      sections.push('Cross-Directory Coupling (import density between top-level dirs):');
      for (const [pair, count] of sorted) {
        sections.push(`  - ${pair}: ${count} imports`);
      }
    }
  }

  // God files (large code files)
  const godFiles = staticResult.fileSizes.largestFiles
    .filter(f => f.lines > 500 && f.classification !== 'data' && f.classification !== 'vendored')
    .slice(0, 5);
  if (godFiles.length > 0) {
    sections.push('Large Files (>500 lines — complex areas, good for hard tasks):');
    for (const f of godFiles) {
      sections.push(`  - ${f.path} (${f.lines} lines)`);
    }
  }

  return sections.length > 0 ? sections.join('\n') : 'No structural hotspots detected.';
}

function computeDifficultyQuotas(count: number): { easy: number; medium: number; hard: number } {
  if (count <= 0) return { easy: 0, medium: 0, hard: 0 };
  if (count === 1) return { easy: 0, medium: 1, hard: 0 };
  if (count === 2) return { easy: 1, medium: 0, hard: 1 };

  const hard = Math.max(1, Math.round(count * DIFFICULTY_DISTRIBUTION.hard));
  const easy = Math.max(1, Math.round(count * DIFFICULTY_DISTRIBUTION.easy));
  const medium = Math.max(0, count - easy - hard);
  return { easy, medium, hard };
}

function correctDifficultyQuotas(
  tasks: Array<{ difficulty: 'easy' | 'medium' | 'hard'; expectedFilesTouch: string[] }>,
  quotas: { easy: number; medium: number; hard: number },
): void {
  // Count actual distribution
  const counts = { easy: 0, medium: 0, hard: 0 };
  for (const t of tasks) counts[t.difficulty]++;

  // If distribution matches, nothing to do
  if (counts.easy === quotas.easy && counts.medium === quotas.medium && counts.hard === quotas.hard) return;

  // Reassign based on expectedFilesTouch length (fewest = easy, most = hard)
  const sorted = [...tasks].sort((a, b) => a.expectedFilesTouch.length - b.expectedFilesTouch.length);
  const difficulties: Array<'easy' | 'medium' | 'hard'> = [
    ...Array(quotas.easy).fill('easy' as const),
    ...Array(quotas.medium).fill('medium' as const),
    ...Array(quotas.hard).fill('hard' as const),
  ];

  for (let i = 0; i < sorted.length && i < difficulties.length; i++) {
    sorted[i].difficulty = difficulties[i];
  }
}
