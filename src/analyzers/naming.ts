import { getSourceFiles, type WalkEntry } from '../core/fs.js';
import { basename } from 'node:path';
import type { NamingResult } from '../types.js';

type Convention = 'camelCase' | 'PascalCase' | 'kebab-case' | 'snake_case' | 'unknown';

// Detects the naming convention of a single file.
// Strips extensions and common suffixes (.test, .spec, etc.) before classifying.
// Single-word all-lowercase names (index, types, utils) are classified as 'unknown' since
// they don't demonstrate a multi-word convention choice — they match every convention equally.
function detectConvention(name: string): Convention {
  const base = name.replace(/\.[^.]+$/, '');
  const cleaned = base.replace(/\.(test|spec|stories|styles|module|config|d)$/i, '');

  // Single-word all-lowercase: ambiguous — doesn't reveal a convention
  if (/^[a-z][a-z0-9]*$/.test(cleaned)) return 'unknown';

  if (/^[a-z][a-zA-Z0-9]*$/.test(cleaned)) return 'camelCase';
  if (/^[A-Z][a-zA-Z0-9]*$/.test(cleaned)) return 'PascalCase';
  if (/^[a-z][a-z0-9]*(-[a-z0-9]+)+$/.test(cleaned)) return 'kebab-case';
  if (/^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(cleaned)) return 'snake_case';
  return 'unknown';
}

// Returns accepted conventions for a directory group.
// Any convention with >=10% representation is considered intentional and accepted.
// This handles React (PascalCase components + camelCase hooks) and mixed-convention
// monorepos without penalizing legitimate multi-convention patterns.
function getAcceptedConventions(files: { convention: Convention }[]): Set<Convention> {
  const counts = new Map<Convention, number>();
  let totalKnown = 0;
  for (const { convention } of files) {
    if (convention !== 'unknown') {
      counts.set(convention, (counts.get(convention) ?? 0) + 1);
      totalKnown++;
    }
  }
  if (totalKnown === 0) return new Set();

  const accepted = new Set<Convention>();
  for (const [conv, count] of counts) {
    if (count / totalKnown >= 0.10) {
      accepted.add(conv);
    }
  }

  // Ensure at least the dominant convention is accepted (for tiny groups)
  if (accepted.size === 0) {
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    if (sorted.length > 0) accepted.add(sorted[0][0]);
  }

  return accepted;
}

// Consistent naming helps LLMs predict file locations without listing directories.
// Uses per-directory convention detection with tolerance for intentional mixed conventions
// (e.g., React: PascalCase components + camelCase hooks). Single-word ambiguous names are
// excluded since they don't demonstrate a naming convention choice.
export function analyzeNaming(entries: WalkEntry[]): NamingResult {
  const sourceFiles = getSourceFiles(entries);
  if (sourceFiles.length === 0) {
    return { conventionScore: 100, inconsistencies: [], dominantConvention: 'unknown', totalFilesAnalyzed: 0 };
  }

  // Group files by top-level directory
  const groups = new Map<string, { name: string; convention: Convention; relativePath: string }[]>();
  for (const file of sourceFiles) {
    const name = basename(file.name);
    const conv = detectConvention(name);
    const firstSlash = file.relativePath.indexOf('/');
    const group = firstSlash === -1 ? '.' : file.relativePath.slice(0, firstSlash);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group)!.push({ name, convention: conv, relativePath: file.relativePath });
  }

  // For each group, find accepted conventions and count consistency
  let totalConsistent = 0;
  let totalKnown = 0;
  const allInconsistencies: string[] = [];
  const seenNames = new Set<string>();
  const groupDominants = new Map<string, Convention>();

  for (const [group, files] of groups) {
    const accepted = getAcceptedConventions(files);
    // Track dominant for display
    const sorted = [...accepted];
    if (sorted.length > 0) groupDominants.set(group, sorted[0]);

    for (const file of files) {
      if (file.convention === 'unknown') continue;
      totalKnown++;
      if (accepted.has(file.convention)) {
        totalConsistent++;
      } else if (allInconsistencies.length < 10 && !seenNames.has(file.name)) {
        seenNames.add(file.name);
        const acceptedStr = [...accepted].join(' or ');
        allInconsistencies.push(`${file.name} uses ${file.convention} (expected ${acceptedStr} in ${group}/)`);
      }
    }
  }

  const consistencyRatio = totalKnown > 0 ? totalConsistent / totalKnown : 1;
  const score = Math.round(consistencyRatio * 100);

  // Report the most common global convention for display
  const globalCounts = new Map<Convention, number>();
  for (const [, conv] of groupDominants) {
    if (conv !== 'unknown') globalCounts.set(conv, (globalCounts.get(conv) ?? 0) + 1);
  }
  let globalDominant: Convention = 'unknown';
  let maxGlobalCount = 0;
  for (const [conv, count] of globalCounts) {
    if (count > maxGlobalCount) { globalDominant = conv; maxGlobalCount = count; }
  }

  return {
    conventionScore: score,
    inconsistencies: allInconsistencies,
    dominantConvention: globalDominant,
    totalFilesAnalyzed: sourceFiles.length,
  };
}
