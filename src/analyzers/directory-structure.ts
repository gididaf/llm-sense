import { getDirs, getSourceFiles, type WalkEntry } from '../core/fs.js';
import type { DirectoryStructureResult } from '../types.js';
import { dirname } from 'node:path';

export function analyzeDirectoryStructure(entries: WalkEntry[]): DirectoryStructureResult {
  const dirs = getDirs(entries);
  const sourceFiles = getSourceFiles(entries);

  if (dirs.length === 0) {
    return {
      maxDepth: 0, avgDepth: 0, totalDirs: 0, deepestPaths: [],
      avgFilesPerDir: sourceFiles.length, maxFilesInDir: { path: '.', count: sourceFiles.length },
    };
  }

  // Calculate depths
  const depths = dirs.map(d => d.relativePath.split('/').length);
  const maxDepth = Math.max(...depths, 0);
  const avgDepth = depths.length > 0 ? Math.round((depths.reduce((a, b) => a + b, 0) / depths.length) * 10) / 10 : 0;

  // Deepest paths
  const sortedByDepth = dirs
    .map(d => ({ path: d.relativePath, depth: d.relativePath.split('/').length }))
    .sort((a, b) => b.depth - a.depth);
  const deepestPaths = sortedByDepth.slice(0, 5).map(d => d.path);

  // Files per directory
  const filesPerDir = new Map<string, number>();
  for (const file of sourceFiles) {
    const dir = dirname(file.relativePath);
    filesPerDir.set(dir, (filesPerDir.get(dir) ?? 0) + 1);
  }

  let maxDir = '.';
  let maxCount = 0;
  let totalFilesInDirs = 0;
  for (const [dir, count] of filesPerDir) {
    totalFilesInDirs += count;
    if (count > maxCount) {
      maxCount = count;
      maxDir = dir;
    }
  }

  const dirsWithFiles = filesPerDir.size || 1;

  return {
    maxDepth,
    avgDepth,
    totalDirs: dirs.length,
    deepestPaths,
    avgFilesPerDir: Math.round((totalFilesInDirs / dirsWithFiles) * 10) / 10,
    maxFilesInDir: { path: maxDir, count: maxCount },
  };
}
