import { readFile, writeFile } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';
import { GENERATED_PATTERNS, SOURCE_EXTENSIONS } from '../constants.js';
import type { StaticAnalysisResult, TokenHeatmapEntry } from '../types.js';
import type { WalkEntry } from '../core/fs.js';

// ─── Types ──────────────────────────────────────────────

export interface TokenOptimizationResult {
  excludeRecommendations: ExcludeRecommendation[];
  compressRecommendations: CompressRecommendation[];
  ignoreFileContents: {
    claudeignore: string;
    cursorignore: string;
    copilotignore: string;
  };
  potentialSavings: {
    excludeTokens: number;
    compressTokens: number;
    totalTokens: number;
    savingsPercent: number;
  };
}

export interface ExcludeRecommendation {
  path: string;
  tokens: number;
  reason: string;
  pattern: string; // glob pattern for ignore file
}

export interface CompressRecommendation {
  path: string;
  tokens: number;
  estimatedCompressedTokens: number;
  reason: string;
  strategy: 'types-only' | 'signatures-only' | 'summarize';
}

// ─── Analysis ───────────────────────────────────────────

export function analyzeTokenOptimization(
  staticResult: StaticAnalysisResult,
  entries: WalkEntry[],
): TokenOptimizationResult {
  const excludeRecommendations: ExcludeRecommendation[] = [];
  const compressRecommendations: CompressRecommendation[] = [];

  // 1. Generated files — always exclude
  for (const entry of entries) {
    if (!entry.isFile) continue;
    const tokens = Math.round(entry.bytes / 4);
    if (tokens < 100) continue;

    for (const pattern of GENERATED_PATTERNS) {
      if (pattern.test(entry.relativePath)) {
        excludeRecommendations.push({
          path: entry.relativePath,
          tokens,
          reason: 'Generated/minified file',
          pattern: entry.name.endsWith('.min.js') ? '*.min.js' :
                   entry.name.endsWith('.min.css') ? '*.min.css' :
                   entry.name.endsWith('.map') ? '*.map' :
                   entry.name.endsWith('.d.ts') ? '*.d.ts' :
                   entry.relativePath,
        });
        break;
      }
    }
  }

  // 2. Large non-source files (configs, data files)
  for (const entry of entries) {
    if (!entry.isFile) continue;
    const tokens = Math.round(entry.bytes / 4);
    if (tokens < 500) continue;

    if (!SOURCE_EXTENSIONS.has(entry.ext) && !entry.ext.match(/\.(md|txt|json|yaml|yml|toml)$/)) {
      excludeRecommendations.push({
        path: entry.relativePath,
        tokens,
        reason: 'Non-source file consuming significant tokens',
        pattern: entry.relativePath,
      });
    }
  }

  // 3. Vendored files (from noise analysis)
  if (staticResult.noise.vendoredFileCount > 0) {
    // Identify vendored-looking directories
    const vendoredDirs = new Set<string>();
    for (const entry of entries) {
      if (!entry.isFile) continue;
      const dir = dirname(entry.relativePath);
      if (dir.includes('vendor') || dir.includes('third_party') || dir.includes('external')) {
        vendoredDirs.add(dir.split('/')[0]);
      }
    }
    for (const dir of vendoredDirs) {
      const dirTokens = entries
        .filter(e => e.isFile && e.relativePath.startsWith(dir + '/'))
        .reduce((s, e) => s + Math.round(e.bytes / 4), 0);
      if (dirTokens > 1000) {
        excludeRecommendations.push({
          path: dir + '/',
          tokens: dirTokens,
          reason: 'Vendored/third-party code',
          pattern: dir + '/**',
        });
      }
    }
  }

  // 4. Large data files detected by fileSizes
  for (const f of staticResult.fileSizes.largestFiles) {
    if (f.classification === 'data' && f.lines > 200) {
      const tokens = Math.round(f.bytes / 4);
      excludeRecommendations.push({
        path: f.path,
        tokens,
        reason: `Data file (${f.lines.toLocaleString()} lines) — extract to separate data store or JSON`,
        pattern: f.path,
      });
    }
    if (f.classification === 'vendored') {
      const tokens = Math.round(f.bytes / 4);
      excludeRecommendations.push({
        path: f.path,
        tokens,
        reason: `Vendored file (${f.lines.toLocaleString()} lines) — replace with package dependency`,
        pattern: f.path,
      });
    }
  }

  // 5. Test files — suggest summarize for large test suites
  const testDirs = new Set<string>();
  for (const entry of entries) {
    if (!entry.isFile) continue;
    if (entry.name.includes('.test.') || entry.name.includes('.spec.') || entry.relativePath.includes('__tests__')) {
      const dir = dirname(entry.relativePath).split('/')[0];
      testDirs.add(dir);
    }
  }

  // 6. Large but important files — suggest compression (types/signatures only)
  const hubPaths = new Set(staticResult.imports.hubFiles.map(h => h.path));
  for (const f of staticResult.fileSizes.largestFiles) {
    if (f.classification !== 'code') continue;
    if (f.lines < 500) continue;

    const tokens = Math.round(f.bytes / 4);
    const isHub = hubPaths.has(f.path);

    if (isHub && f.lines > 500) {
      compressRecommendations.push({
        path: f.path,
        tokens,
        estimatedCompressedTokens: Math.round(tokens * 0.3), // ~70% reduction from types-only
        reason: `Hub file (${f.lines} lines, fan-in ${staticResult.imports.hubFiles.find(h => h.path === f.path)?.fanIn ?? 0}) — extract types/interfaces for AI context`,
        strategy: 'types-only',
      });
    } else if (f.lines > 1000) {
      compressRecommendations.push({
        path: f.path,
        tokens,
        estimatedCompressedTokens: Math.round(tokens * 0.4), // ~60% reduction from signatures
        reason: `Large file (${f.lines} lines) — extract function signatures for AI context`,
        strategy: 'signatures-only',
      });
    }
  }

  // Deduplicate by path
  const seen = new Set<string>();
  const deduped = excludeRecommendations.filter(r => {
    if (seen.has(r.path)) return false;
    seen.add(r.path);
    return true;
  });

  // Sort by token savings
  deduped.sort((a, b) => b.tokens - a.tokens);
  compressRecommendations.sort((a, b) =>
    (b.tokens - b.estimatedCompressedTokens) - (a.tokens - a.estimatedCompressedTokens));

  // Calculate savings — use total tokens from all walked files, not just source heatmap
  const allFileTokens = entries.filter(e => e.isFile).reduce((s, e) => s + Math.round(e.bytes / 4), 0);
  const excludeTokens = deduped.reduce((s, r) => s + r.tokens, 0);
  const compressTokens = compressRecommendations.reduce((s, r) => s + (r.tokens - r.estimatedCompressedTokens), 0);
  const totalTokens = allFileTokens || staticResult.tokenHeatmap.total;
  const savingsPercent = totalTokens > 0 ? Math.min(95, Math.round(((excludeTokens + compressTokens) / totalTokens) * 100)) : 0;

  // Build ignore file contents
  const excludePatterns = [...new Set(deduped.map(r => r.pattern))];

  // Common patterns for all ignore files
  const commonPatterns = [
    '# Generated/build artifacts',
    '*.min.js',
    '*.min.css',
    '*.map',
    '*.d.ts',
    'dist/',
    'build/',
    '.next/',
    '',
    '# Dependencies',
    'node_modules/',
    'vendor/',
    '',
    '# Lock files',
    'package-lock.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    '',
    '# Data/binary files',
    '*.sqlite',
    '*.db',
    '*.csv',
    '',
  ];

  // Add project-specific patterns
  const projectPatterns: string[] = [];
  for (const r of deduped.slice(0, 20)) {
    if (!commonPatterns.includes(r.pattern) && !r.pattern.startsWith('*.')) {
      projectPatterns.push(r.pattern);
    }
  }

  if (projectPatterns.length > 0) {
    commonPatterns.push('# Project-specific exclusions');
    commonPatterns.push(...projectPatterns);
    commonPatterns.push('');
  }

  // Test directories — suggest for context optimization
  if (testDirs.size > 0) {
    commonPatterns.push('# Test files (optional — exclude for smaller context)');
    commonPatterns.push('# **/*.test.*');
    commonPatterns.push('# **/*.spec.*');
    commonPatterns.push('# __tests__/');
    commonPatterns.push('');
  }

  const ignoreContent = commonPatterns.join('\n');

  return {
    excludeRecommendations: deduped.slice(0, 30),
    compressRecommendations: compressRecommendations.slice(0, 10),
    ignoreFileContents: {
      claudeignore: `# .claudeignore — Files to exclude from Claude Code context\n${ignoreContent}`,
      cursorignore: `# .cursorignore — Files to exclude from Cursor AI context\n${ignoreContent}`,
      copilotignore: `# .copilotignore — Files to exclude from GitHub Copilot context\n${ignoreContent}`,
    },
    potentialSavings: {
      excludeTokens,
      compressTokens,
      totalTokens,
      savingsPercent,
    },
  };
}

// ─── Generate Ignore Files ──────────────────────────────

export async function generateIgnoreFiles(
  targetPath: string,
  result: TokenOptimizationResult,
): Promise<string[]> {
  const files: Array<{ name: string; content: string }> = [
    { name: '.claudeignore', content: result.ignoreFileContents.claudeignore },
    { name: '.cursorignore', content: result.ignoreFileContents.cursorignore },
    { name: '.copilotignore', content: result.ignoreFileContents.copilotignore },
  ];

  const created: string[] = [];
  for (const f of files) {
    const path = join(targetPath, f.name);
    await writeFile(path, f.content, 'utf-8');
    created.push(f.name);
  }
  return created;
}
