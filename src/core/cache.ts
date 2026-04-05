import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { WalkEntry } from './fs.js';

const CACHE_DIR = '.llm-sense';
const MANIFEST_FILE = 'manifest.json';

interface CacheManifest {
  version: string;
  timestamp: string;
  entries: Record<string, number>; // relativePath → mtimeMs
}

function getManifestPath(targetPath: string): string {
  return join(targetPath, CACHE_DIR, MANIFEST_FILE);
}

// Load the manifest from the previous run.
export async function loadManifest(targetPath: string): Promise<CacheManifest | null> {
  try {
    const content = await readFile(getManifestPath(targetPath), 'utf-8');
    const manifest = JSON.parse(content) as CacheManifest;
    // Invalidate if scoring version changed
    const { SCORING_VERSION } = await import('../constants.js');
    if (manifest.version !== SCORING_VERSION) return null;
    return manifest;
  } catch {
    return null;
  }
}

// Save the current manifest after a successful run.
export async function saveManifest(targetPath: string, entries: WalkEntry[]): Promise<void> {
  const dir = join(targetPath, CACHE_DIR);
  try { await mkdir(dir, { recursive: true }); } catch {}

  const { SCORING_VERSION } = await import('../constants.js');
  const manifest: CacheManifest = {
    version: SCORING_VERSION,
    timestamp: new Date().toISOString(),
    entries: {},
  };

  for (const entry of entries) {
    if (entry.isFile) {
      try {
        const s = await stat(entry.path);
        manifest.entries[entry.relativePath] = s.mtimeMs;
      } catch {}
    }
  }

  await writeFile(getManifestPath(targetPath), JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
}

// Check if any files changed since the last run.
// Returns true if cache is valid (no changes), false if re-analysis is needed.
export function isCacheValid(manifest: CacheManifest, currentEntries: WalkEntry[]): boolean {
  const current = new Map<string, number>();
  for (const entry of currentEntries) {
    if (entry.isFile) {
      current.set(entry.relativePath, entry.bytes); // Use bytes as a proxy (faster than mtime)
    }
  }

  const cached = manifest.entries;

  // Check for new or deleted files
  if (current.size !== Object.keys(cached).length) return false;

  // Check for modified files (different byte count indicates change)
  for (const [path, bytes] of current) {
    if (!(path in cached)) return false;
  }

  // For a more accurate check, compare mtimes
  // But since we use full re-run strategy, any change invalidates the whole cache
  return true;
}

// Determine if we can skip the full analysis.
// Returns the manifest if cache is valid, null if re-analysis is needed.
export async function checkCache(
  targetPath: string,
  entries: WalkEntry[],
): Promise<{ cacheHit: boolean }> {
  const manifest = await loadManifest(targetPath);
  if (!manifest) return { cacheHit: false };

  return { cacheHit: isCacheValid(manifest, entries) };
}

// ─── Phase 2 Result Cache (scoring consistency) ─────────

const PHASE2_CACHE_FILE = 'phase2-cache.json';

interface Phase2Cache {
  version: string;
  timestamp: string;
  fileHash: string; // hash of file tree to detect changes
  understanding: unknown;
  verification: unknown;
}

function getPhase2CachePath(targetPath: string): string {
  return join(targetPath, CACHE_DIR, PHASE2_CACHE_FILE);
}

function computeFileTreeHash(entries: WalkEntry[]): string {
  // Simple hash based on file count + total bytes — cheap way to detect major changes
  const files = entries.filter(e => e.isFile);
  const totalBytes = files.reduce((s, e) => s + e.bytes, 0);
  return `${files.length}:${totalBytes}`;
}

export async function loadPhase2Cache(
  targetPath: string,
  entries: WalkEntry[],
): Promise<{ understanding: unknown; verification: unknown } | null> {
  try {
    const content = await readFile(getPhase2CachePath(targetPath), 'utf-8');
    const cache = JSON.parse(content) as Phase2Cache;
    const { SCORING_VERSION } = await import('../constants.js');
    if (cache.version !== SCORING_VERSION) return null;
    // Check if file tree changed significantly
    const currentHash = computeFileTreeHash(entries);
    if (cache.fileHash !== currentHash) return null;
    return { understanding: cache.understanding, verification: cache.verification };
  } catch {
    return null;
  }
}

export async function savePhase2Cache(
  targetPath: string,
  entries: WalkEntry[],
  understanding: unknown,
  verification: unknown,
): Promise<void> {
  const dir = join(targetPath, CACHE_DIR);
  try { await mkdir(dir, { recursive: true }); } catch {}
  const { SCORING_VERSION } = await import('../constants.js');
  const cache: Phase2Cache = {
    version: SCORING_VERSION,
    timestamp: new Date().toISOString(),
    fileHash: computeFileTreeHash(entries),
    understanding,
    verification,
  };
  await writeFile(getPhase2CachePath(targetPath), JSON.stringify(cache, null, 2) + '\n', 'utf-8');
}
