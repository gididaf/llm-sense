import { readFileSafe, stratifiedSample, getSourceFiles, type WalkEntry } from '../core/fs.js';

export interface DuplicatePair {
  fileA: string;
  fileB: string;
  similarity: number;
  sharedExports: string[];
}

export interface DuplicatesResult {
  pairs: DuplicatePair[];
  totalFilesScanned: number;
}

// Extract exported names via regex (no AST dependency)
const EXPORT_PATTERN = /export\s+(?:default\s+)?(?:function|class|const|let|var|type|interface|enum)\s+(\w+)/g;
// Python-style exports
const PYTHON_DEF_PATTERN = /^(?:def|class)\s+(\w+)/gm;
// Go-style exports (capitalized functions)
const GO_EXPORT_PATTERN = /^func\s+(?:\([^)]+\)\s+)?([A-Z]\w+)/gm;

function extractExportNames(content: string, ext: string): Set<string> {
  const names = new Set<string>();

  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
    let match: RegExpExecArray | null;
    const re = new RegExp(EXPORT_PATTERN.source, EXPORT_PATTERN.flags);
    while ((match = re.exec(content)) !== null) {
      names.add(match[1]);
    }
  } else if (['.py'].includes(ext)) {
    let match: RegExpExecArray | null;
    const re = new RegExp(PYTHON_DEF_PATTERN.source, PYTHON_DEF_PATTERN.flags);
    while ((match = re.exec(content)) !== null) {
      if (!match[1].startsWith('_')) names.add(match[1]);
    }
  } else if (['.go'].includes(ext)) {
    let match: RegExpExecArray | null;
    const re = new RegExp(GO_EXPORT_PATTERN.source, GO_EXPORT_PATTERN.flags);
    while ((match = re.exec(content)) !== null) {
      names.add(match[1]);
    }
  }

  return names;
}

// Jaccard similarity: |A ∩ B| / |A ∪ B|
function jaccardSimilarity(a: Set<string>, b: Set<string>): { similarity: number; shared: string[] } {
  if (a.size === 0 && b.size === 0) return { similarity: 0, shared: [] };
  const shared: string[] = [];
  for (const item of a) {
    if (b.has(item)) shared.push(item);
  }
  const unionSize = a.size + b.size - shared.length;
  return { similarity: unionSize > 0 ? shared.length / unionSize : 0, shared };
}

export async function analyzeDuplicates(entries: WalkEntry[]): Promise<DuplicatesResult> {
  const sourceFiles = getSourceFiles(entries);
  const sampled = stratifiedSample(sourceFiles, 300);

  // Build fingerprints: file → { exports, bytes }
  const fingerprints: Array<{ path: string; exports: Set<string>; bytes: number }> = [];

  for (const file of sampled) {
    const content = await readFileSafe(file.path, 32_000);
    if (!content) continue;
    const exports = extractExportNames(content, file.ext);
    // Only fingerprint files with 3+ exports (otherwise too generic)
    if (exports.size >= 3) {
      fingerprints.push({ path: file.relativePath, exports, bytes: file.bytes });
    }
  }

  // Group by similar size (within 30% of each other) to reduce O(n²) comparisons
  fingerprints.sort((a, b) => a.bytes - b.bytes);
  const pairs: DuplicatePair[] = [];

  for (let i = 0; i < fingerprints.length; i++) {
    for (let j = i + 1; j < fingerprints.length; j++) {
      const a = fingerprints[i];
      const b = fingerprints[j];

      // Size filter: skip if >50% size difference
      if (b.bytes > a.bytes * 1.5) break;

      const { similarity, shared } = jaccardSimilarity(a.exports, b.exports);
      if (similarity > 0.6) {
        pairs.push({
          fileA: a.path,
          fileB: b.path,
          similarity: Math.round(similarity * 100) / 100,
          sharedExports: shared.slice(0, 10),
        });
      }
    }
  }

  // Sort by similarity descending
  pairs.sort((a, b) => b.similarity - a.similarity);

  return {
    pairs: pairs.slice(0, 20), // Cap at 20 pairs
    totalFilesScanned: sampled.length,
  };
}
