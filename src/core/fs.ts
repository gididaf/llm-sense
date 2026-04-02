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
