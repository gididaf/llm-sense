import { readFile } from 'node:fs/promises';
import { dirname, resolve, extname } from 'node:path';
import { getSourceFiles, stratifiedSample, type WalkEntry } from '../core/fs.js';
import type { ImportsResult } from '../types.js';

function countImports(content: string, ext: string): number {
  const lines = content.split('\n');
  let count = 0;

  for (const line of lines) {
    const trimmed = line.trim();

    if (ext === '.py') {
      if (trimmed.startsWith('import ') || trimmed.startsWith('from ')) count++;
    } else if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
      if (trimmed.startsWith('import ') || trimmed.match(/require\s*\(/)) count++;
    } else if (ext === '.rs') {
      if (trimmed.startsWith('use ')) count++;
    } else if (['.c', '.cpp', '.cc', '.h', '.hpp'].includes(ext)) {
      if (trimmed.startsWith('#include')) count++;
    } else if (ext === '.go') {
      if (trimmed.startsWith('import')) count++;
    } else {
      if (trimmed.startsWith('import ') || trimmed.startsWith('from ')) count++;
    }
  }

  return count;
}

// Extract relative import paths from source file content.
// Supports JS/TS (import/require), Python (from . import), Rust (use crate::).
function extractLocalImports(content: string, ext: string): string[] {
  const deps: string[] = [];

  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
    // Match: import ... from './path' or require('./path')
    for (const m of content.matchAll(/(?:from|require\s*\()\s*['"](\.[^'"]+)['"]/g)) {
      deps.push(m[1]);
    }
  } else if (ext === '.py') {
    // Match: from .module import ... or from ..module import ...
    for (const m of content.matchAll(/from\s+(\.+\w*)\s+import/g)) {
      deps.push(m[1]);
    }
  } else if (ext === '.rs') {
    // Match: use crate::module or use super::module
    for (const m of content.matchAll(/use\s+(crate|super)::([\w:]+)/g)) {
      deps.push(`${m[1]}::${m[2]}`);
    }
  }

  return deps;
}

// Resolve a relative import path to a file's relativePath in the entry set.
// e.g., from 'src/core/claude.ts' importing './git' resolves to 'src/core/git.ts'
function resolveImport(
  importerRelPath: string,
  importPath: string,
  fileIndex: Map<string, string>,
): string | null {
  const dir = dirname(importerRelPath);
  // Strip extension from import path if present, we'll try candidates
  const base = importPath.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, '');
  const resolved = resolve('/', dir, base).slice(1); // use '/' as virtual root

  // Try exact match, then with extensions, then /index variants
  const candidates = [
    resolved,
    ...(['.ts', '.tsx', '.js', '.jsx'].map(e => resolved + e)),
    resolved + '/index.ts',
    resolved + '/index.js',
  ];

  for (const c of candidates) {
    if (fileIndex.has(c)) return c;
  }
  return null;
}

// Compute the maximum dependency chain depth using iterative BFS.
function computeMaxChainDepth(graph: Map<string, Set<string>>): number {
  let maxDepth = 0;

  for (const startNode of graph.keys()) {
    const visited = new Set<string>();
    const queue: [string, number][] = [[startNode, 0]];

    while (queue.length > 0) {
      const [node, depth] = queue.shift()!;
      if (visited.has(node)) continue;
      visited.add(node);
      maxDepth = Math.max(maxDepth, depth);

      const neighbors = graph.get(node);
      if (neighbors) {
        for (const n of neighbors) {
          if (!visited.has(n)) queue.push([n, depth + 1]);
        }
      }
    }
  }

  return maxDepth;
}

export async function analyzeImports(entries: WalkEntry[]): Promise<ImportsResult> {
  const sourceFiles = getSourceFiles(entries);

  let totalImports = 0;
  let maxImportsPath = '';
  let maxImportsCount = 0;

  // Build file index for import resolution: relativePath (no ext) → relativePath
  const fileIndex = new Map<string, string>();
  for (const f of sourceFiles) {
    fileIndex.set(f.relativePath, f.relativePath);
  }

  const sampleSize = Math.min(sourceFiles.length, sourceFiles.length > 500 ? 400 : 200);
  const sampled = stratifiedSample(sourceFiles, sampleSize);

  // Build dependency graph: file → Set<files it imports>
  const graph = new Map<string, Set<string>>();

  for (const file of sampled) {
    try {
      const content = await readFile(file.path, 'utf-8');
      const imports = countImports(content, file.ext);
      totalImports += imports;

      if (imports > maxImportsCount) {
        maxImportsCount = imports;
        maxImportsPath = file.relativePath;
      }

      // Build graph edges from local imports
      const localImports = extractLocalImports(content, file.ext);
      const resolved = new Set<string>();
      for (const imp of localImports) {
        const target = resolveImport(file.relativePath, imp, fileIndex);
        if (target) resolved.add(target);
      }
      if (resolved.size > 0) {
        graph.set(file.relativePath, resolved);
      }
    } catch {}
  }

  // Compute fan-in (how many files import each file)
  const fanInCount = new Map<string, number>();
  for (const [, deps] of graph) {
    for (const dep of deps) {
      fanInCount.set(dep, (fanInCount.get(dep) ?? 0) + 1);
    }
  }

  // Fan-out: average number of local imports per file (files with graph entries)
  const fanOuts = [...graph.values()].map(s => s.size);
  const avgFanOut = fanOuts.length > 0
    ? Math.round((fanOuts.reduce((a, b) => a + b, 0) / fanOuts.length) * 10) / 10
    : 0;

  // Fan-in: average across all files that ARE imported
  const fanIns = [...fanInCount.values()];
  const avgFanIn = fanIns.length > 0
    ? Math.round((fanIns.reduce((a, b) => a + b, 0) / fanIns.length) * 10) / 10
    : 0;

  // Hub files: files with fan-in > 10 (many other files depend on them)
  const hubFiles = [...fanInCount.entries()]
    .filter(([, count]) => count > 10)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([path, fanIn]) => ({ path, fanIn }));

  // Orphan files: in the sample, neither import nor are imported by any other sampled file
  const allGraphFiles = new Set<string>();
  for (const [src, deps] of graph) {
    allGraphFiles.add(src);
    for (const d of deps) allGraphFiles.add(d);
  }
  const orphanFiles = sampled
    .filter(f => !allGraphFiles.has(f.relativePath))
    .map(f => f.relativePath)
    .slice(0, 20);

  // Max dependency chain depth
  const maxChainDepth = computeMaxChainDepth(graph);

  // Count external dependencies
  let externalDependencyCount = 0;
  for (const entry of entries) {
    if (entry.name === 'package.json' && entry.isFile) {
      try {
        const content = await readFile(entry.path, 'utf-8');
        const pkg = JSON.parse(content);
        externalDependencyCount += Object.keys(pkg.dependencies ?? {}).length;
        externalDependencyCount += Object.keys(pkg.devDependencies ?? {}).length;
      } catch {}
    }
  }

  return {
    avgImportsPerFile: sampled.length > 0 ? Math.round((totalImports / sampled.length) * 10) / 10 : 0,
    maxImportsInFile: { path: maxImportsPath, count: maxImportsCount },
    circularDeps: [],
    externalDependencyCount,
    avgFanOut,
    avgFanIn,
    hubFiles,
    orphanFiles,
    maxChainDepth,
  };
}
