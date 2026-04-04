import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getSourceFiles, stratifiedSample, detectVibeCoderFiles, type WalkEntry } from '../core/fs.js';
import { CLAUDE_MD_SECTIONS } from '../constants.js';
import type { DocumentationResult, ClaudeMdContentScore, AiConfigScore, ConfigDriftResult, StaleReference } from '../types.js';

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

// Generic AI config file scoring. Checks for project context, coding conventions,
// file structure hints, and architecture guidance — the same concepts as CLAUDE.md
// but adapted for other AI tool config formats.
const AI_CONFIG_KEYWORDS = [
  'architecture', 'structure', 'pattern', 'convention', 'module',
  'test', 'build', 'deploy', 'stack', 'framework', 'database',
  'important', 'avoid', 'prefer', 'always', 'never', 'rule',
  'file', 'directory', 'component', 'function', 'class', 'type',
];

function scoreAiConfigContent(content: string): number {
  if (!content.trim()) return 0;
  const lower = content.toLowerCase();
  const lines = content.split('\n').length;

  // Base score from length (more content = more useful)
  let score = Math.min(lines / 5, 30); // up to 30 pts for 150+ lines

  // Keyword depth: what fraction of AI config keywords appear?
  const matches = AI_CONFIG_KEYWORDS.filter(kw => lower.includes(kw)).length;
  score += (matches / AI_CONFIG_KEYWORDS.length) * 50; // up to 50 pts

  // Has code blocks (suggests examples)?
  if (content.includes('```')) score += 10;

  // Has headings (suggests structure)?
  if (/^#+\s/m.test(content)) score += 10;

  return Math.min(Math.round(score), 100);
}

// Files to score as AI config. Each gets existence + content scoring.
const AI_CONFIG_FILES = [
  { path: '.cursorrules', name: '.cursorrules' },
  { path: '.github/copilot-instructions.md', name: 'copilot-instructions.md' },
  { path: 'AGENTS.md', name: 'AGENTS.md' },
  { path: '.clinerules', name: '.clinerules' },
  { path: '.claude/settings.json', name: '.claude/settings.json' },
];

// Score an AI config file using the same 8-section analysis as CLAUDE.md.
// Returns both the generic content score and per-section scores.
function scoreAiConfigSections(content: string): { contentScore: number; sectionScores: Record<string, { found: boolean; score: number }> } {
  if (!content.trim()) return { contentScore: 0, sectionScores: {} };

  const lower = content.toLowerCase();
  const lines = content.split('\n');
  const headings = lines
    .filter(l => l.startsWith('#'))
    .map(l => l.toLowerCase().replace(/^#+\s*/, ''));

  const sectionScores: Record<string, { found: boolean; score: number }> = {};
  for (const [key, config] of Object.entries(CLAUDE_MD_SECTIONS)) {
    const headingMatch = headings.some(h =>
      config.keywords.some(kw => h.includes(kw)),
    );
    const bodyMatches = config.keywords.filter(kw => lower.includes(kw)).length;
    const bodyScore = Math.min(bodyMatches / Math.max(config.keywords.length * 0.4, 1), 1);

    if (headingMatch) {
      sectionScores[key] = { found: true, score: Math.min(0.5 + bodyScore * 0.5, 1) };
    } else if (bodyScore > 0.3) {
      sectionScores[key] = { found: true, score: bodyScore * 0.5 };
    } else {
      sectionScores[key] = { found: false, score: 0 };
    }
  }

  // Blend: 60% section analysis + 40% generic content scoring
  const sectionTotal = Object.values(sectionScores).reduce((s, v) => s + v.score, 0);
  const sectionMax = Object.keys(sectionScores).length;
  const sectionPct = Math.round((sectionTotal / sectionMax) * 100);
  const genericScore = scoreAiConfigContent(content);
  const contentScore = Math.round(sectionPct * 0.6 + genericScore * 0.4);

  return { contentScore, sectionScores };
}

async function scoreAiConfigs(rootPath: string): Promise<AiConfigScore[]> {
  const results: AiConfigScore[] = [];

  for (const config of AI_CONFIG_FILES) {
    const fullPath = join(rootPath, config.path);
    let exists = false;
    let contentScore = 0;
    let lines = 0;
    let sectionScores: Record<string, { found: boolean; score: number }> | undefined;

    try {
      await access(fullPath);
      exists = true;
      const content = await readFile(fullPath, 'utf-8');
      lines = content.split('\n').length;

      if (config.path.endsWith('.json')) {
        const parsed = JSON.parse(content);
        const keys = Object.keys(parsed);
        contentScore = Math.min(keys.length * 15, 100);
      } else {
        const result = scoreAiConfigSections(content);
        contentScore = result.contentScore;
        sectionScores = result.sectionScores;
      }
    } catch {}

    results.push({ file: config.name, exists, contentScore, lines, sectionScores });
  }

  return results;
}

// ─── Config Drift Detection ──────────────────────────────

// Regex to extract path-like references from config files.
// Only matches paths that contain a `/` (directory separators) to avoid false positives
// like "Express.js", "index.ts", or brand names with dots.
const PATH_PATTERN = /(?:^|\s|`)((?:\.\.?\/|src\/|lib\/|app\/|packages\/|tests?\/|scripts?\/)[^\s`'",:;)}\]]+)/gm;

// Regex to extract command references (handles backtick-wrapped commands)
const COMMAND_PATTERN = /(?:^|\s|`)((?:npm|npx|pnpm|yarn|bun)\s+(?:run\s+)?([\w:@./-]+))|(?:^|\s|`)(make\s+([\w-]+))/gm;

async function detectConfigDrift(
  rootPath: string,
  configFiles: Array<{ path: string; content: string }>,
): Promise<ConfigDriftResult> {
  const staleReferences: StaleReference[] = [];
  let totalReferences = 0;
  let validReferences = 0;

  // Load package.json scripts for command validation (root + workspace packages)
  const packageScripts: Set<string> = new Set();
  const pkgJsonPaths = [join(rootPath, 'package.json')];
  // Also check common workspace locations
  for (const dir of ['backend', 'frontend', 'server', 'client', 'api', 'web', 'app', 'packages']) {
    pkgJsonPaths.push(join(rootPath, dir, 'package.json'));
  }
  for (const pkgPath of pkgJsonPaths) {
    try {
      const pkgContent = await readFile(pkgPath, 'utf-8');
      const pkg = JSON.parse(pkgContent);
      if (pkg.scripts) {
        for (const name of Object.keys(pkg.scripts)) packageScripts.add(name);
      }
    } catch {}
  }

  // Check for Makefile targets
  let makeTargets: Set<string> = new Set();
  try {
    const makefile = await readFile(join(rootPath, 'Makefile'), 'utf-8');
    const targets = makefile.match(/^([a-zA-Z_][\w-]*)\s*:/gm);
    if (targets) makeTargets = new Set(targets.map(t => t.replace(':', '').trim()));
  } catch {}

  for (const config of configFiles) {
    const lines = config.content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Skip lines that are just headings, empty, or markdown formatting
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') && !trimmed.includes('`')) continue;

      // Check path references
      let pathMatch: RegExpExecArray | null;
      const pathRegex = new RegExp(PATH_PATTERN.source, PATH_PATTERN.flags);
      while ((pathMatch = pathRegex.exec(line)) !== null) {
        const ref = pathMatch[1].replace(/[`'"]/g, '');

        // Skip URLs, anchors, version numbers, common non-path patterns
        if (ref.includes('://') || ref.startsWith('#') || /^\d+\.\d+/.test(ref)) continue;
        // Skip markdown links, image refs
        if (ref.endsWith(')') || ref.endsWith(']')) continue;
        // Skip file extensions that are clearly references to types, not files
        if (ref.startsWith('.') && !ref.startsWith('./') && !ref.startsWith('../')) continue;

        totalReferences++;
        const fullPath = join(rootPath, ref);
        if (await fileExists(fullPath)) {
          validReferences++;
        } else {
          staleReferences.push({
            file: config.path,
            line: i + 1,
            reference: ref,
            type: 'path',
            reason: 'file or directory not found',
          });
        }
      }

      // Check command references
      const BUILTIN_NPM_COMMANDS = new Set(['install', 'ci', 'init', 'publish', 'pack', 'link', 'uninstall', 'update', 'outdated', 'ls', 'audit', 'version', 'login', 'logout', 'whoami', 'cache', 'config', 'help']);
      let cmdMatch: RegExpExecArray | null;
      const cmdRegex = new RegExp(COMMAND_PATTERN.source, COMMAND_PATTERN.flags);
      while ((cmdMatch = cmdRegex.exec(line)) !== null) {
        // npm/pnpm/yarn script
        if (cmdMatch[2]) {
          const script = cmdMatch[2];
          // Skip built-in npm commands (install, ci, etc.) — they don't need a scripts entry
          if (BUILTIN_NPM_COMMANDS.has(script)) continue;
          totalReferences++;
          if (packageScripts.has(script)) {
            validReferences++;
          } else {
            staleReferences.push({
              file: config.path,
              line: i + 1,
              reference: `npm run ${script}`,
              type: 'command',
              reason: `no "${script}" script in package.json`,
            });
          }
        }
        // make target
        if (cmdMatch[4]) {
          const target = cmdMatch[4];
          totalReferences++;
          if (makeTargets.has(target)) {
            validReferences++;
          } else {
            staleReferences.push({
              file: config.path,
              line: i + 1,
              reference: `make ${target}`,
              type: 'command',
              reason: `no "${target}" target in Makefile`,
            });
          }
        }
      }
    }
  }

  const freshnessScore = totalReferences > 0
    ? Math.round((validReferences / totalReferences) * 100)
    : 100; // No references = nothing stale

  return { totalReferences, validReferences, staleReferences, freshnessScore };
}

// ─── AI Config Coverage & Consistency ────────────────────

function computeAiConfigCoverage(configs: AiConfigScore[]): number {
  const existingCount = configs.filter(c => c.exists).length;
  if (existingCount === 0) return 0;
  if (existingCount === 1) return 3;
  if (existingCount === 2) return 5;
  return 8; // 3+
}

// Cross-file consistency: check that config files referencing tech stack/patterns agree
function computeAiConfigConsistency(
  claudeMdContent: string | null,
  configContents: Array<{ path: string; content: string }>,
): number {
  if (!claudeMdContent || configContents.length === 0) return 100; // Nothing to compare

  // Extract key terms from CLAUDE.md as ground truth
  const truthLower = claudeMdContent.toLowerCase();
  const techTerms = ['typescript', 'javascript', 'python', 'react', 'vue', 'angular', 'svelte',
    'next.js', 'express', 'django', 'flask', 'rust', 'go', 'java', 'ruby',
    'postgresql', 'mysql', 'mongodb', 'redis', 'docker', 'kubernetes'];

  const truthTerms = techTerms.filter(t => truthLower.includes(t));
  if (truthTerms.length === 0) return 100; // No tech terms to compare

  let contradictions = 0;
  for (const config of configContents) {
    const lower = config.content.toLowerCase();
    // Check for contradictions: config mentions competing tech not in CLAUDE.md
    // E.g., CLAUDE.md says TypeScript but .cursorrules says Python
    for (const term of techTerms) {
      const inTruth = truthTerms.includes(term);
      const inConfig = lower.includes(term);
      // Only flag if config mentions something CLAUDE.md doesn't, and it's a language/framework
      // (not just a tool reference)
      if (inConfig && !inTruth) {
        // Soft check: is it a primary language/framework mention, not just a passing reference?
        const mentions = (lower.match(new RegExp(term, 'gi')) || []).length;
        if (mentions >= 3) contradictions++;
      }
    }
  }

  // -2 pts per contradiction, minimum 0
  return Math.max(0, 100 - contradictions * 2);
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
  const sampleSize = Math.min(sourceFiles.length, sourceFiles.length > 500 ? 100 : 50);
  const sampled = stratifiedSample(sourceFiles, sampleSize);

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

  // Score AI config files beyond CLAUDE.md
  const aiConfigScores = await scoreAiConfigs(rootPath);

  // Config drift detection: scan all AI config files for stale references
  const configFilesForDrift: Array<{ path: string; content: string }> = [];
  if (claudeMdContent) {
    configFilesForDrift.push({ path: 'CLAUDE.md', content: claudeMdContent.rawContent });
  }
  for (const config of AI_CONFIG_FILES) {
    try {
      const fullPath = join(rootPath, config.path);
      await access(fullPath);
      const content = await readFile(fullPath, 'utf-8');
      configFilesForDrift.push({ path: config.path, content });
    } catch {}
  }
  const configDrift = await detectConfigDrift(rootPath, configFilesForDrift);

  // AI config coverage & consistency
  const aiConfigCoverage = computeAiConfigCoverage(aiConfigScores);
  const configContents = configFilesForDrift.filter(c => c.path !== 'CLAUDE.md');
  const aiConfigConsistency = computeAiConfigConsistency(
    claudeMdContent?.rawContent ?? null,
    configContents,
  );

  return {
    hasReadme,
    hasClaudeMd,
    readmeLines,
    claudeMdLines,
    inlineCommentRatio,
    totalSourceFiles: sourceFiles.length,
    claudeMdContent,
    vibeCoderContext,
    aiConfigScores,
    configDrift,
    aiConfigCoverage,
    aiConfigConsistency,
  };
}
