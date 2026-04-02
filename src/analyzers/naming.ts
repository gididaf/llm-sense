import { getSourceFiles, type WalkEntry } from '../core/fs.js';
import { basename } from 'node:path';
import type { NamingResult } from '../types.js';

type Convention = 'camelCase' | 'PascalCase' | 'kebab-case' | 'snake_case' | 'unknown';

function detectConvention(name: string): Convention {
  // Remove extension
  const base = name.replace(/\.[^.]+$/, '');
  // Remove common suffixes like .test, .spec, .stories
  const cleaned = base.replace(/\.(test|spec|stories|styles|module|config|d)$/i, '');

  if (/^[a-z][a-zA-Z0-9]*$/.test(cleaned)) return 'camelCase';
  if (/^[A-Z][a-zA-Z0-9]*$/.test(cleaned)) return 'PascalCase';
  if (/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(cleaned)) return 'kebab-case';
  if (/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/.test(cleaned)) return 'snake_case';
  return 'unknown';
}

export function analyzeNaming(entries: WalkEntry[]): NamingResult {
  const sourceFiles = getSourceFiles(entries);
  if (sourceFiles.length === 0) {
    return { conventionScore: 100, inconsistencies: [], dominantConvention: 'unknown', totalFilesAnalyzed: 0 };
  }

  const conventions = new Map<Convention, number>();
  const fileConventions: { name: string; convention: Convention }[] = [];

  for (const file of sourceFiles) {
    const name = basename(file.name);
    const conv = detectConvention(name);
    conventions.set(conv, (conventions.get(conv) ?? 0) + 1);
    fileConventions.push({ name, convention: conv });
  }

  // Find dominant convention (excluding 'unknown')
  let dominant: Convention = 'unknown';
  let dominantCount = 0;
  for (const [conv, count] of conventions) {
    if (conv !== 'unknown' && count > dominantCount) {
      dominant = conv;
      dominantCount = count;
    }
  }

  const knownFiles = sourceFiles.length - (conventions.get('unknown') ?? 0);
  const consistencyRatio = knownFiles > 0 ? dominantCount / knownFiles : 1;
  const score = Math.round(consistencyRatio * 100);

  // Find inconsistencies (files not matching dominant convention), deduplicated by name
  const inconsistencies: string[] = [];
  const seen = new Set<string>();
  for (const { name, convention } of fileConventions) {
    if (convention !== dominant && convention !== 'unknown' && !seen.has(name) && inconsistencies.length < 10) {
      seen.add(name);
      inconsistencies.push(`${name} uses ${convention} (expected ${dominant})`);
    }
  }

  return {
    conventionScore: score,
    inconsistencies,
    dominantConvention: dominant,
    totalFilesAnalyzed: sourceFiles.length,
  };
}
