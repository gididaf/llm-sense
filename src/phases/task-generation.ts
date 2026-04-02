import { callClaudeStructured, callClaudeWithRetry } from '../core/claude.js';
import { readFileSafe, getSourceFiles, type WalkEntry } from '../core/fs.js';
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

  // Build file list with line counts
  const fileList = sourceFiles
    .map(f => f.relativePath)
    .slice(0, 300)
    .join('\n');

  // Sample a few source files to give Claude a sense of code style
  const sampleCount = Math.min(8, sourceFiles.length);
  const step = Math.max(1, Math.floor(sourceFiles.length / sampleCount));
  const sampledFiles: string[] = [];

  for (let i = 0; i < sourceFiles.length && sampledFiles.length < sampleCount; i += step) {
    const file = sourceFiles[i];
    const content = await readFileSafe(file.path, 8000);
    if (content) {
      const lines = content.split('\n').slice(0, 150).join('\n');
      sampledFiles.push(`--- ${file.relativePath} ---\n${lines}`);
    }
  }

  const prompt = `You are generating synthetic development tasks for a codebase to test how easily an LLM can work with it.

CODEBASE UNDERSTANDING:
- Project: ${understanding.projectName}
- Description: ${understanding.description}
- Tech Stack: ${understanding.techStack.map(t => `${t.name} (${t.category})`).join(', ')}
- Architecture: ${understanding.architecture.pattern}
- Entry Points: ${understanding.architecture.entryPoints.join(', ')}
- Complexity: ${understanding.complexity}
- Code Organization: ${understanding.conventions.codeOrganization}

SOURCE FILES (${sourceFiles.length} total, showing first 300):
${fileList}

CODE SAMPLES:
${sampledFiles.join('\n\n')}

Generate exactly ${bugCount} synthetic bug tasks and ${featureCount} synthetic feature tasks.

RULES:
- Tasks should span DIFFERENT areas of the codebase (not all in one module)
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
