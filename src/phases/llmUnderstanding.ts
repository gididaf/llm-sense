import { callClaudeStructured, callClaudeWithRetry } from '../core/claude.js';
import { readFileSafe, buildTree, getSourceFiles, stratifiedSample, type WalkEntry } from '../core/fs.js';
import { DEPENDENCY_FILE_NAMES } from '../constants.js';
import {
  CodebaseUnderstandingSchema,
  LlmVerificationSchema,
  type CodebaseUnderstanding,
  type LlmVerification,
  type LlmVerificationAdjustments,
  type StaticAnalysisResult,
} from '../types.js';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';

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

// Phase 2b: LLM Verification — validates static analysis findings with an LLM.
// Runs a focused call to check documentation quality, naming clarity, and architecture.
// Returns adjustments (±15 points) for each category.
export async function runLlmVerification(
  targetPath: string,
  entries: WalkEntry[],
  staticResult: StaticAnalysisResult,
  verbose: boolean,
  model?: string,
): Promise<{ adjustments: LlmVerificationAdjustments; verification: LlmVerification; costUsd: number; durationMs: number }> {
  if (verbose) console.log('  Building verification prompt...');

  // Build a focused context: directory tree + sampled file snippets + CLAUDE.md
  const tree = buildTree(entries, 300, 3);
  const claudeMd = await readFileSafe(join(targetPath, 'CLAUDE.md'), 3000);

  // Sample a few files to show naming patterns
  const sourceFiles = getSourceFiles(entries);
  const sampled = stratifiedSample(sourceFiles, 10);
  const snippets: string[] = [];
  for (const file of sampled) {
    try {
      const content = await readFile(file.path, 'utf-8');
      const firstLines = content.split('\n').slice(0, 20).join('\n');
      snippets.push(`--- ${file.relativePath} (first 20 lines) ---\n${firstLines}`);
    } catch {}
  }

  const prompt = `You are verifying the LLM-friendliness of a codebase. Evaluate three aspects on a scale of 1-10.

DIRECTORY TREE (first 300 entries):
${tree}

${claudeMd ? `CLAUDE.md CONTENT:\n${claudeMd}\n` : 'No CLAUDE.md exists.'}

SAMPLE FILE SNIPPETS:
${snippets.join('\n\n')}

STATIC ANALYSIS FINDINGS:
- File naming convention: ${staticResult.naming.dominantConvention} (${staticResult.naming.conventionScore}% consistency)
- Documentation: ${staticResult.documentation.hasClaudeMd ? 'CLAUDE.md exists' : 'No CLAUDE.md'}, ${staticResult.documentation.hasReadme ? 'README exists' : 'No README'}
- Comment ratio: ${(staticResult.documentation.inlineCommentRatio * 100).toFixed(1)}%

Evaluate:
1. **Documentation quality** (1-10): Is the CLAUDE.md/documentation actually helpful and accurate, or is it boilerplate? Does it contain real, actionable guidance?
2. **Naming clarity** (1-10): Are function/file/variable names clear and self-documenting? Would an LLM understand the codebase from names alone?
3. **Architecture clarity** (1-10): Can you understand the codebase structure from the directory layout? Is the architecture obvious or confusing?`;

  if (verbose) console.log('  Calling Claude for LLM verification...');

  const { data, result } = await callClaudeWithRetry(
    () => callClaudeStructured(
      { prompt, cwd: targetPath, timeout: 120_000, model, tools: '', bare: false },
      LlmVerificationSchema,
    ),
  );

  const adjustments = computeLlmAdjustments(data);

  return {
    adjustments,
    verification: data,
    costUsd: result.costUsd,
    durationMs: result.durationMs,
  };
}

// Convert 1-10 LLM verification scores to ±15 scoring adjustments.
// Score 5 = neutral (0 adjustment), 10 = +15, 1 = -15
export function computeLlmAdjustments(data: LlmVerification): LlmVerificationAdjustments {
  const scaleAdjustment = (score: number) => Math.round((score - 5) * 3);
  return {
    documentation: scaleAdjustment(data.documentationQuality.score),
    naming: scaleAdjustment(data.namingClarity.score),
    coupling: scaleAdjustment(data.architectureClarity.score),
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
