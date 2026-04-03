import { callClaudeStructured, callClaudeWithRetry } from '../core/claude.js';
import { readFileSafe, getSourceFiles, stratifiedSample, buildDirectorySummary, type WalkEntry } from '../core/fs.js';
import { TaskGenerationResponseSchema, type TaskGenerationResponse, type CodebaseUnderstanding } from '../types.js';

export async function runTaskGeneration(
  targetPath: string,
  entries: WalkEntry[],
  understanding: CodebaseUnderstanding,
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

  const prompt = `You are generating synthetic development tasks for a codebase to test how easily an LLM can work with it.

CODEBASE UNDERSTANDING:
- Project: ${understanding.projectName}
- Description: ${understanding.description}
- Tech Stack: ${understanding.techStack.map(t => `${t.name} (${t.category})`).join(', ')}
- Architecture: ${understanding.architecture.pattern}
- Entry Points: ${understanding.architecture.entryPoints.join(', ')}
- Complexity: ${understanding.complexity}
- Code Organization: ${understanding.conventions.codeOrganization}

DIRECTORY OVERVIEW (${sourceFiles.length} source files across ${dirCount} directories):
${dirSummary}

CODE SAMPLES (${sampledFiles.length} representative files from different areas):
${sampledFiles.join('\n\n')}

Generate exactly ${bugCount} synthetic bug tasks and ${featureCount} synthetic feature tasks.

RULES:
- Tasks MUST span at least ${minDirSpan} different directories — do NOT cluster tasks in one area
- Mix difficulties: include easy, medium, and hard tasks
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

  return {
    data,
    costUsd: result.costUsd,
    durationMs: result.durationMs,
  };
}
