import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getSourceFiles, detectVibeCoderFiles, type WalkEntry } from '../core/fs.js';
import { CLAUDE_MD_SECTIONS } from '../constants.js';
import type { DocumentationResult, ClaudeMdContentScore } from '../types.js';

async function fileLines(path: string): Promise<number> {
  try {
    const content = await readFile(path, 'utf-8');
    return content.split('\n').length;
  } catch {
    return 0;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// Scores CLAUDE.md content quality by checking for 8 essential sections.
// Each section is scored 0-1 based on: heading presence (0.5 base) + keyword depth in body.
// A section can be "found" even without a heading if enough keywords appear in the body,
// but scores lower (capped at 0.5) to encourage explicit section structure.
function scoreClaudeMdContent(content: string): ClaudeMdContentScore {
  const lower = content.toLowerCase();
  const lines = content.split('\n');

  const headings = lines
    .filter(l => l.startsWith('#'))
    .map(l => l.toLowerCase().replace(/^#+\s*/, ''));

  const sections: Record<string, { found: boolean; score: number }> = {};
  const missingSections: string[] = [];

  for (const [key, config] of Object.entries(CLAUDE_MD_SECTIONS)) {
    const headingMatch = headings.some(h =>
      config.keywords.some(kw => h.includes(kw)),
    );

    // Body depth: what fraction of section keywords appear anywhere in the file?
    // Threshold is 40% of keywords to count as "mentioned" without a heading.
    const bodyMatches = config.keywords.filter(kw => lower.includes(kw)).length;
    const bodyScore = Math.min(bodyMatches / Math.max(config.keywords.length * 0.4, 1), 1);

    if (headingMatch) {
      // Dedicated heading found — 0.5 base + up to 0.5 from content depth
      const score = Math.min(0.5 + bodyScore * 0.5, 1);
      sections[key] = { found: true, score };
    } else if (bodyScore > 0.3) {
      // Topic mentioned in body without heading — capped at half score
      sections[key] = { found: true, score: bodyScore * 0.5 };
    } else {
      sections[key] = { found: false, score: 0 };
      missingSections.push(config.name);
    }
  }

  const totalScore = Object.values(sections).reduce((sum, s) => sum + s.score, 0);
  const maxScore = Object.keys(sections).length;
  const overallContentScore = Math.round((totalScore / maxScore) * 100);

  return {
    sections,
    overallContentScore,
    missingSections,
    rawContent: content,
  };
}

export async function analyzeDocumentation(
  rootPath: string,
  entries: WalkEntry[],
): Promise<DocumentationResult> {
  const readmePath = join(rootPath, 'README.md');
  const claudeMdPath = join(rootPath, 'CLAUDE.md');

  const hasReadme = await fileExists(readmePath);
  const hasClaudeMd = await fileExists(claudeMdPath);
  const readmeLines = hasReadme ? await fileLines(readmePath) : 0;
  const claudeMdLines = hasClaudeMd ? await fileLines(claudeMdPath) : 0;

  // Deep CLAUDE.md content scoring
  let claudeMdContent: ClaudeMdContentScore | null = null;
  if (hasClaudeMd) {
    try {
      const content = await readFile(claudeMdPath, 'utf-8');
      claudeMdContent = scoreClaudeMdContent(content);
    } catch {}
  }

  // Find CLAUDE.md files in subdirectories
  const subdirectoryClaudeMdPaths = entries
    .filter(e => e.isFile && e.name === 'CLAUDE.md' && e.relativePath !== 'CLAUDE.md')
    .map(e => e.relativePath);

  // Detect vibe coder context files
  const vibeCoderContext = await detectVibeCoderFiles(rootPath);
  vibeCoderContext.subdirectoryClaudeMdPaths = subdirectoryClaudeMdPaths;

  // Estimate inline comment ratio by sampling up to 50 source files.
  // We sample rather than scanning all files to keep Phase 1 fast (~300ms target).
  const sourceFiles = getSourceFiles(entries);
  let totalLines = 0;
  let commentLines = 0;
  const sampleSize = Math.min(sourceFiles.length, 50);
  const sampled = sourceFiles.slice(0, sampleSize);

  for (const file of sampled) {
    try {
      const content = await readFile(file.path, 'utf-8');
      const lines = content.split('\n');
      totalLines += lines.length;

      for (const line of lines) {
        const trimmed = line.trim();
        if (
          trimmed.startsWith('//') ||
          trimmed.startsWith('#') ||
          trimmed.startsWith('/*') ||
          trimmed.startsWith('*') ||
          trimmed.startsWith('"""') ||
          trimmed.startsWith("'''")
        ) {
          commentLines++;
        }
      }
    } catch {}
  }

  const inlineCommentRatio = totalLines > 0
    ? Math.round((commentLines / totalLines) * 1000) / 1000
    : 0;

  return {
    hasReadme,
    hasClaudeMd,
    readmeLines,
    claudeMdLines,
    inlineCommentRatio,
    totalSourceFiles: sourceFiles.length,
    claudeMdContent,
    vibeCoderContext,
  };
}
