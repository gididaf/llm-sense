import { readFile } from 'node:fs/promises';
import { dirname, basename } from 'node:path';
import { getSourceFiles, getDirs, type WalkEntry } from '../core/fs.js';
import type { ModularityResult } from '../types.js';

// Evaluates how well code is organized into modules with appropriate granularity.
// Checks: files per directory (too many = hard to navigate), single-file dirs (over-splitting),
// and barrel exports (index.ts/js files that re-export — helps LLMs discover module APIs).
export function analyzeModularity(entries: WalkEntry[]): ModularityResult {
  const sourceFiles = getSourceFiles(entries);
  const dirs = getDirs(entries);

  // Count files per directory to detect over-stuffed directories
  const filesPerDir = new Map<string, number>();
  for (const file of sourceFiles) {
    const dir = dirname(file.relativePath);
    filesPerDir.set(dir, (filesPerDir.get(dir) ?? 0) + 1);
  }

  let maxDir = '.';
  let maxCount = 0;
  let singleFileDirs = 0;
  let totalFilesInDirs = 0;

  for (const [dir, count] of filesPerDir) {
    totalFilesInDirs += count;
    if (count > maxCount) {
      maxCount = count;
      maxDir = dir;
    }
    if (count === 1) {
      singleFileDirs++;
    }
  }

  const dirsWithFiles = filesPerDir.size || 1;

  // Count barrel exports (index.ts/index.js files that re-export)
  let barrelExportCount = 0;
  for (const file of sourceFiles) {
    const name = basename(file.name);
    if (name === 'index.ts' || name === 'index.js' || name === 'index.tsx' || name === 'index.jsx') {
      barrelExportCount++;
    }
  }

  return {
    avgFilesPerDirectory: Math.round((totalFilesInDirs / dirsWithFiles) * 10) / 10,
    maxFilesInDirectory: { path: maxDir, count: maxCount },
    singleFileDirectories: singleFileDirs,
    totalDirectories: dirs.length,
    barrelExportCount,
  };
}
