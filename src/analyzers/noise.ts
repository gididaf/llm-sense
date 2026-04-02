import { isBinaryFile, isSourceFile, type WalkEntry } from '../core/fs.js';
import { GENERATED_PATTERNS, LOCKFILE_NAMES } from '../constants.js';
import type { NoiseResult } from '../types.js';

// Measures the signal-to-noise ratio: what fraction of files are actual source code
// vs generated files, binaries, and lockfiles that waste LLM context tokens.
export function analyzeNoise(entries: WalkEntry[]): NoiseResult {
  const files = entries.filter(e => e.isFile);

  let generatedFileCount = 0;
  let lockfileBytes = 0;
  let binaryFileCount = 0;
  let sourceFileCount = 0;

  for (const file of files) {
    if (isBinaryFile(file.ext)) {
      binaryFileCount++;
      continue;
    }

    if (isSourceFile(file.ext)) {
      sourceFileCount++;
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

  const totalFiles = files.length;
  const noiseFiles = generatedFileCount + binaryFileCount;
  const sourceToNoiseRatio = totalFiles > 0
    ? Math.round((sourceFileCount / totalFiles) * 1000) / 1000
    : 1;

  return {
    generatedFileCount,
    lockfileBytes,
    binaryFileCount,
    sourceToNoiseRatio,
    totalFiles,
    sourceFiles: sourceFileCount,
  };
}
