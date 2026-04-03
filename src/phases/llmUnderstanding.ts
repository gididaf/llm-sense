import { callClaudeStructured, callClaudeWithRetry } from '../core/claude.js';
import { readFileSafe, buildTree, getSourceFiles, type WalkEntry } from '../core/fs.js';
import { DEPENDENCY_FILE_NAMES } from '../constants.js';
import { CodebaseUnderstandingSchema, type CodebaseUnderstanding, type StaticAnalysisResult } from '../types.js';
import { join } from 'node:path';

export async function runLlmUnderstanding(
  targetPath: string,
  entries: WalkEntry[],
  staticResult: StaticAnalysisResult,
  verbose: boolean,
  model?: string,
): Promise<{ data: CodebaseUnderstanding; costUsd: number; durationMs: number }> {
  if (verbose) console.log('  Building prompt for codebase understanding...');

  // Scale tree view limits with repo size
  const entryCount = entries.length;
  const treeMaxEntries = entryCount > 1000 ? 1200 : entryCount > 200 ? 800 : 500;
  const treeMaxDepth = entryCount > 200 ? 4 : 3;
  const tree = buildTree(entries, treeMaxEntries, treeMaxDepth);

  // Read key documentation files
  const readme = await readFileSafe(join(targetPath, 'README.md'), 5000);
  const claudeMd = await readFileSafe(join(targetPath, 'CLAUDE.md'), 5000);

  // Read dependency files
  const depContents: string[] = [];
  for (const entry of entries) {
    if (entry.isFile && DEPENDENCY_FILE_NAMES.has(entry.name)) {
      const content = await readFileSafe(entry.path, 3000);
      if (content) {
        depContents.push(`--- ${entry.relativePath} ---\n${content}`);
      }
    }
  }

  // Static analysis summary
  const staticSummary = formatStaticSummary(staticResult);

  const sourceFiles = getSourceFiles(entries);
  const prompt = `You are analyzing a codebase to understand its structure, tech stack, and architecture.

DIRECTORY TREE:
${tree}

TOTAL SOURCE FILES: ${sourceFiles.length}
TOTAL LINES OF CODE: ${staticResult.fileSizes.totalLines}

${readme ? `README.md:\n${readme}\n` : 'No README.md found.'}

${claudeMd ? `CLAUDE.md:\n${claudeMd}\n` : 'No CLAUDE.md found.'}

DEPENDENCY FILES:
${depContents.length > 0 ? depContents.join('\n\n') : 'None found.'}

STATIC ANALYSIS SUMMARY:
${staticSummary}

Based on this information, provide a comprehensive understanding of this codebase. Analyze its tech stack, architecture, conventions, and complexity. Also estimate how many tokens the key files would consume in an LLM context window (assume ~4 chars per token).

Focus on aspects that affect LLM-friendliness: how easy is it for an LLM to navigate, understand, and modify this codebase?`;

  if (verbose) console.log('  Calling Claude for codebase understanding...');

  const { data, result } = await callClaudeWithRetry(
    () => callClaudeStructured(
      { prompt, cwd: targetPath, timeout: 120_000, model, tools: '', bare: false },
      CodebaseUnderstandingSchema,
    ),
  );

  return {
    data,
    costUsd: result.costUsd,
    durationMs: result.durationMs,
  };
}

function formatStaticSummary(s: StaticAnalysisResult): string {
  return `- Files: ${s.fileSizes.totalFiles} source files, ${s.fileSizes.totalLines} total lines
- File sizes: median ${s.fileSizes.medianLines} lines, p90 ${s.fileSizes.p90Lines} lines, ${s.fileSizes.filesOver1000Lines} files over 1000 lines
- Largest files: ${s.fileSizes.largestFiles.slice(0, 3).map(f => `${f.path} (${f.lines} lines)`).join(', ')}
- Directory depth: max ${s.directoryStructure.maxDepth}, avg ${s.directoryStructure.avgDepth}
- Naming: ${s.naming.dominantConvention} convention, ${s.naming.conventionScore}% consistency
- Documentation: README ${s.documentation.hasReadme ? '✓' : '✗'}, CLAUDE.md ${s.documentation.hasClaudeMd ? '✓' : '✗'}, comment ratio ${(s.documentation.inlineCommentRatio * 100).toFixed(1)}%
- Imports: avg ${s.imports.avgImportsPerFile} per file, max ${s.imports.maxImportsInFile.count} in ${s.imports.maxImportsInFile.path}
- Modularity: avg ${s.modularity.avgFilesPerDirectory} files/dir, ${s.modularity.singleFileDirectories} single-file dirs, ${s.modularity.barrelExportCount} barrel exports
- Noise: ${s.noise.sourceFiles} source / ${s.noise.totalFiles} total files (${(s.noise.sourceToNoiseRatio * 100).toFixed(0)}% source), ${s.noise.generatedFileCount} generated, ${s.noise.binaryFileCount} binary`;
}
