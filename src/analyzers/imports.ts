import { readFile } from 'node:fs/promises';
import { getSourceFiles, type WalkEntry } from '../core/fs.js';
import type { ImportsResult } from '../types.js';

const IMPORT_PATTERNS = [
  /^\s*import\s/m,                        // JS/TS import
  /^\s*from\s+['"].*['"]\s+import/m,      // Python from...import
  /^\s*require\s*\(/m,                    // CommonJS require
  /^\s*use\s+/m,                          // Rust use
  /^\s*#include\s/m,                      // C/C++ include
];

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
      // Generic: count import-like statements
      if (trimmed.startsWith('import ') || trimmed.startsWith('from ')) count++;
    }
  }

  return count;
}

export async function analyzeImports(entries: WalkEntry[]): Promise<ImportsResult> {
  const sourceFiles = getSourceFiles(entries);

  let totalImports = 0;
  let maxImportsPath = '';
  let maxImportsCount = 0;

  const sampleSize = Math.min(sourceFiles.length, 200);
  const sampled = sourceFiles.slice(0, sampleSize);

  for (const file of sampled) {
    try {
      const content = await readFile(file.path, 'utf-8');
      const imports = countImports(content, file.ext);
      totalImports += imports;

      if (imports > maxImportsCount) {
        maxImportsCount = imports;
        maxImportsPath = file.relativePath;
      }
    } catch {}
  }

  // Simple circular dependency detection for JS/TS
  // Build a basic dependency graph from import paths
  const importGraph = new Map<string, Set<string>>();
  const jsFiles = sampled.filter(f => ['.ts', '.tsx', '.js', '.jsx'].includes(f.ext));

  for (const file of jsFiles) {
    try {
      const content = await readFile(file.path, 'utf-8');
      const deps = new Set<string>();
      const importMatches = content.matchAll(/(?:import|from)\s+['"](\.[^'"]+)['"]/g);

      for (const match of importMatches) {
        deps.add(match[1]);
      }

      if (deps.size > 0) {
        importGraph.set(file.relativePath, deps);
      }
    } catch {}
  }

  // Count external dependencies from package.json etc
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
    circularDeps: [], // Full circular dep detection is expensive; skip for static analysis
    externalDependencyCount,
  };
}
