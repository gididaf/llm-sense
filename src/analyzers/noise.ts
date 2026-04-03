import { isBinaryFile, isSourceFile, isVendoredFile, type WalkEntry } from '../core/fs.js';
import { GENERATED_PATTERNS, LOCKFILE_NAMES } from '../constants.js';
import type { NoiseResult } from '../types.js';

// Measures the signal-to-noise ratio: what fraction of files are actual source code
// vs generated files, binaries, vendored libraries, and lockfiles that waste LLM context tokens.
export async function analyzeNoise(entries: WalkEntry[]): Promise<NoiseResult> {
  const files = entries.filter(e => e.isFile);

  let generatedFileCount = 0;
  let lockfileBytes = 0;
  let binaryFileCount = 0;
  let vendoredFileCount = 0;
  let sourceFileCount = 0;

  // Collect source files for vendored check
  const sourceFilesToCheck: WalkEntry[] = [];

  for (const file of files) {
    if (isBinaryFile(file.ext)) {
      binaryFileCount++;
      continue;
    }

    if (isSourceFile(file.ext)) {
      sourceFileCount++;
      sourceFilesToCheck.push(file);
    }

    if (LOCKFILE_NAMES.has(file.name)) {
      lockfileBytes += file.bytes;
    }

    for (const pattern of GENERATED_PATTERNS) {
      if (pattern.test(file.relativePath)) {
        generatedFileCount++;
        break;
      }
    }
  }

  // Check for vendored files among source files (only files >1KB to focus on substantial files)
  const vendoredCandidates = sourceFilesToCheck.filter(f => f.bytes > 1024);
  const vendoredChecks = vendoredCandidates.map(f => isVendoredFile(f.path));
  const vendoredResults = await Promise.all(vendoredChecks);
  vendoredFileCount = vendoredResults.filter(Boolean).length;

  const totalFiles = files.length;
  const sourceToNoiseRatio = totalFiles > 0
    ? Math.round((sourceFileCount / totalFiles) * 1000) / 1000
    : 1;

  return {
    generatedFileCount,
    lockfileBytes,
    binaryFileCount,
    vendoredFileCount,
    sourceToNoiseRatio,
    totalFiles,
    sourceFiles: sourceFileCount,
  };
}
