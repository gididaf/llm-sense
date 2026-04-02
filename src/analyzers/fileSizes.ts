import { countLines, getSourceFiles, type WalkEntry } from '../core/fs.js';
import type { FileSizeDistribution, FileInfo } from '../types.js';

// Analyzes the distribution of file sizes across source files.
// Key metrics: median lines (typical file), P90 (long tail), and god-file count (>1000 lines).
// These directly correlate with LLM context efficiency — smaller, focused files mean the LLM
// can load just what it needs rather than pulling in an entire 3000-line monolith.
export async function analyzeFileSizes(entries: WalkEntry[]): Promise<FileSizeDistribution> {
  const sourceFiles = getSourceFiles(entries);

  if (sourceFiles.length === 0) {
    return {
      totalFiles: 0, totalLines: 0, avgLines: 0, medianLines: 0,
      p90Lines: 0, p99Lines: 0, filesOver500Lines: 0, filesOver1000Lines: 0,
      largestFiles: [],
    };
  }

  const lineCounts: { path: string; lines: number; bytes: number }[] = [];

  // Count lines in parallel for speed — file I/O is the bottleneck in Phase 1
  await Promise.all(
    sourceFiles.map(async (file) => {
      const lines = await countLines(file.path);
      lineCounts.push({ path: file.relativePath, lines, bytes: file.bytes });
    }),
  );

  lineCounts.sort((a, b) => a.lines - b.lines);

  const totalLines = lineCounts.reduce((sum, f) => sum + f.lines, 0);
  const totalFiles = lineCounts.length;

  const percentile = (arr: number[], p: number): number => {
    const idx = Math.ceil((p / 100) * arr.length) - 1;
    return arr[Math.max(0, idx)];
  };

  const sorted = lineCounts.map(f => f.lines);

  const largestFiles: FileInfo[] = lineCounts
    .slice(-10)
    .reverse()
    .map(f => ({ path: f.path, lines: f.lines, bytes: f.bytes }));

  return {
    totalFiles,
    totalLines,
    avgLines: Math.round(totalLines / totalFiles),
    medianLines: percentile(sorted, 50),
    p90Lines: percentile(sorted, 90),
    p99Lines: percentile(sorted, 99),
    filesOver500Lines: lineCounts.filter(f => f.lines > 500).length,
    filesOver1000Lines: lineCounts.filter(f => f.lines > 1000).length,
    largestFiles,
  };
}
