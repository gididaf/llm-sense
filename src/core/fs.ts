import { readdir, stat, readFile } from 'node:fs/promises';
import { join, extname, basename, relative } from 'node:path';
import { IGNORED_DIRS, BINARY_EXTENSIONS, SOURCE_EXTENSIONS } from '../constants.js';

export interface WalkEntry {
  path: string;
  relativePath: string;
  name: string;
  ext: string;
  isFile: boolean;
  isDir: boolean;
  bytes: number;
}

// Recursively walks a directory tree, collecting metadata for every file and directory.
// Skips dotfiles/dirs by design (to avoid .git/, .next/, etc.) — vibe coder files like
// .claude/ are detected separately by detectVibeCoderFiles() using direct fs.access().
export async function walkDir(
  rootPath: string,
  opts: { maxDepth?: number } = {},
): Promise<WalkEntry[]> {
  const maxDepth = opts.maxDepth ?? 20;
  const entries: WalkEntry[] = [];

  async function walk(dirPath: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;

    let items;
    try {
      items = await readdir(dirPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const item of items) {
      if (IGNORED_DIRS.has(item.name)) continue;
      // Skip all dotfiles except .env.example (useful for setup documentation)
      if (item.name.startsWith('.') && item.name !== '.env.example') continue;

      const fullPath = join(dirPath, item.name);
      const relPath = relative(rootPath, fullPath);

      if (item.isDirectory()) {
        entries.push({
          path: fullPath,
          relativePath: relPath,
          name: item.name,
          ext: '',
          isFile: false,
          isDir: true,
          bytes: 0,
        });
        await walk(fullPath, depth + 1);
      } else if (item.isFile()) {
        let bytes = 0;
        try {
          const s = await stat(fullPath);
          bytes = s.size;
        } catch {}

        entries.push({
          path: fullPath,
          relativePath: relPath,
          name: item.name,
          ext: extname(item.name).toLowerCase(),
          isFile: true,
          isDir: false,
          bytes,
        });
      }
    }
  }

  await walk(rootPath, 0);
  return entries;
}

export function isSourceFile(ext: string): boolean {
  return SOURCE_EXTENSIONS.has(ext);
}

export function isBinaryFile(ext: string): boolean {
  return BINARY_EXTENSIONS.has(ext);
}

export async function countLines(filePath: string): Promise<number> {
  try {
    const content = await readFile(filePath, 'utf-8');
    return content.split('\n').length;
  } catch {
    return 0;
  }
}

// Reads a file with a byte cap to prevent OOM on large generated files (e.g., 50MB lockfiles).
// Returns empty string on any error — callers don't need to handle missing/inaccessible files.
export async function readFileSafe(filePath: string, maxBytes: number = 50_000): Promise<string> {
  try {
    const s = await stat(filePath);
    if (s.size > maxBytes) {
      const buf = Buffer.alloc(maxBytes);
      const { open } = await import('node:fs/promises');
      const fh = await open(filePath, 'r');
      await fh.read(buf, 0, maxBytes, 0);
      await fh.close();
      return buf.toString('utf-8');
    }
    return await readFile(filePath, 'utf-8');
  } catch {
    return '';
  }
}

// Builds a text tree view of the directory structure for inclusion in Claude prompts.
// Capped at maxEntries/maxDepth to keep prompts within reasonable token limits.
export function buildTree(entries: WalkEntry[], maxEntries: number = 500, maxDepth: number = 3): string {
  const lines: string[] = [];
  let count = 0;

  for (const entry of entries) {
    if (count >= maxEntries) {
      lines.push(`... and ${entries.length - count} more entries`);
      break;
    }

    const depth = entry.relativePath.split('/').length - 1;
    if (depth > maxDepth) continue;

    const indent = '  '.repeat(depth);
    const prefix = entry.isDir ? '/' : '';
    lines.push(`${indent}${entry.name}${prefix}`);
    count++;
  }

  return lines.join('\n');
}

export function getSourceFiles(entries: WalkEntry[]): WalkEntry[] {
  return entries.filter(e => e.isFile && isSourceFile(e.ext));
}

export function getDirs(entries: WalkEntry[]): WalkEntry[] {
  return entries.filter(e => e.isDir);
}

// Groups source files by top-level directory and samples proportionally from each group.
// Ensures every directory area gets representation, avoiding the bias of simple .slice(0, N).
// For repos with fewer files than maxSamples, returns all files unchanged.
export function stratifiedSample(files: WalkEntry[], maxSamples: number): WalkEntry[] {
  if (files.length <= maxSamples) return files;

  // Group by top-level directory (first path segment)
  const groups = new Map<string, WalkEntry[]>();
  for (const file of files) {
    const firstSlash = file.relativePath.indexOf('/');
    const group = firstSlash === -1 ? '.' : file.relativePath.slice(0, firstSlash);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group)!.push(file);
  }

  // Allocate slots proportionally, with at least 1 per group
  const totalFiles = files.length;
  const allocations = new Map<string, number>();
  let totalAllocated = 0;

  for (const [group, groupFiles] of groups) {
    const slots = Math.max(1, Math.round(groupFiles.length / totalFiles * maxSamples));
    allocations.set(group, slots);
    totalAllocated += slots;
  }

  // Trim from largest groups if we over-allocated due to min-1 guarantee
  if (totalAllocated > maxSamples) {
    const sorted = [...allocations.entries()].sort((a, b) => b[1] - a[1]);
    let excess = totalAllocated - maxSamples;
    for (const [group, slots] of sorted) {
      if (excess <= 0) break;
      const trim = Math.min(excess, slots - 1);
      allocations.set(group, slots - trim);
      excess -= trim;
    }
  }

  // Sample evenly within each group
  const result: WalkEntry[] = [];
  for (const [group, groupFiles] of groups) {
    const slots = allocations.get(group)!;
    if (slots >= groupFiles.length) {
      result.push(...groupFiles);
    } else {
      const step = Math.max(1, Math.floor(groupFiles.length / slots));
      let picked = 0;
      for (let i = 0; i < groupFiles.length && picked < slots; i += step) {
        result.push(groupFiles[i]);
        picked++;
      }
    }
  }

  return result.slice(0, maxSamples);
}

// Builds a directory overview showing parent directories with file counts.
// Gives Claude full breadth visibility without listing every individual path.
export function buildDirectorySummary(files: WalkEntry[]): string {
  const groups = new Map<string, number>();
  for (const file of files) {
    const lastSlash = file.relativePath.lastIndexOf('/');
    const dir = lastSlash === -1 ? '(root)' : file.relativePath.slice(0, lastSlash);
    groups.set(dir, (groups.get(dir) ?? 0) + 1);
  }

  // Sort by count descending, cap at 60 directories for prompt size
  const sorted = [...groups.entries()].sort((a, b) => b[1] - a[1]);
  const shown = sorted.slice(0, 60);
  const lines = shown.map(([dir, count]) => `${dir}/ (${count} files)`);

  if (sorted.length > 60) {
    const remaining = sorted.slice(60).reduce((sum, [, c]) => sum + c, 0);
    lines.push(`... and ${sorted.length - 60} more directories (${remaining} files)`);
  }

  return lines.join('\n');
}

// Detects AI coding tool configuration files (.claude/, .cursorrules, etc.).
// Uses direct fs.access() rather than walkDir because walkDir skips dotfiles.
export async function detectVibeCoderFiles(rootPath: string): Promise<import('../types.js').VibeCoderContextFiles> {
  const { VIBE_CODER_FILES } = await import('../constants.js');

  const check = async (relPath: string): Promise<boolean> => {
    try {
      await access(join(rootPath, relPath));
      return true;
    } catch {
      return false;
    }
  };

  const hasClaudeDir = await check('.claude');
  const hasCursorRules = await check('.cursorrules');
  const hasCursorIgnore = await check('.cursorignore');
  const hasCopilotInstructions = await check('.github/copilot-instructions.md');
  const hasClineRules = await check('.clinerules');

  const detectedTools: string[] = [];
  if (hasClaudeDir) detectedTools.push('Claude Code');
  if (hasCursorRules || hasCursorIgnore) detectedTools.push('Cursor AI');
  if (hasCopilotInstructions) detectedTools.push('GitHub Copilot');
  if (hasClineRules) detectedTools.push('Cline AI');

  return {
    hasClaudeDir,
    hasCursorRules,
    hasCursorIgnore,
    hasCopilotInstructions,
    hasClineRules,
    subdirectoryClaudeMdPaths: [], // populated by documentation analyzer
    detectedTools,
  };
}
