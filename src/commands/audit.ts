import { access, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import chalk from 'chalk';
import { detectExistingFormats, getAllFormats, type ConfigFormat } from '../configs/registry.js';
import { CLAUDE_MD_SECTIONS } from '../constants.js';
import type { AuditConfigResult, AuditDimensionScore, AuditResult } from '../types.js';

// ─── Helpers ─────────────────────────────────────────────

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readFileSafe(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return null;
  }
}

async function getFileMtime(path: string): Promise<Date | null> {
  try {
    const s = await stat(path);
    return s.mtime;
  } catch {
    return null;
  }
}

// ─── Path Extraction & Validation ────────────────────────

const PATH_PATTERN = /(?:^|\s|`)((?:\.\.?\/|src\/|lib\/|app\/|packages\/|tests?\/|scripts?\/)[^\s`'",:;)}\]]+)/gm;

function extractPaths(content: string): Array<{ line: number; path: string }> {
  const results: Array<{ line: number; path: string }> = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const regex = new RegExp(PATH_PATTERN.source, PATH_PATTERN.flags);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(lines[i])) !== null) {
      const ref = match[1].replace(/[`'"]/g, '');
      if (ref.includes('://') || ref.startsWith('#') || /^\d+\.\d+/.test(ref)) continue;
      if (ref.endsWith(')') || ref.endsWith(']')) continue;
      if (ref.startsWith('.') && !ref.startsWith('./') && !ref.startsWith('../')) continue;
      if (ref.includes('{')) continue;
      results.push({ line: i + 1, path: ref });
    }
  }
  return results;
}

// ─── Code Block Extraction & Validation ──────────────────

interface CodeBlock {
  line: number;
  lang: string;
  content: string;
}

function extractCodeBlocks(content: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  const lines = content.split('\n');
  let inBlock = false;
  let blockStart = 0;
  let blockLang = '';
  let blockLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!inBlock && trimmed.startsWith('```')) {
      inBlock = true;
      blockStart = i + 1;
      blockLang = trimmed.slice(3).trim().split(/\s/)[0] || '';
      blockLines = [];
    } else if (inBlock && trimmed === '```') {
      inBlock = false;
      if (blockLines.length > 0) {
        blocks.push({ line: blockStart, lang: blockLang, content: blockLines.join('\n') });
      }
    } else if (inBlock) {
      blockLines.push(lines[i]);
    }
  }
  return blocks;
}

// Check if a code block's content appears in the actual source files
async function validateCodeBlock(rootPath: string, block: CodeBlock): Promise<{ valid: boolean; reason?: string }> {
  // Skip shell/command blocks — they describe how to run things, not source code
  if (['bash', 'sh', 'shell', 'zsh', 'console', 'terminal', 'cmd', 'powershell'].includes(block.lang)) {
    return { valid: true };
  }
  // Skip very short blocks (likely examples, not real code references)
  if (block.content.split('\n').length < 3) return { valid: true };

  // Extract identifiers that look like they reference real code (function/class/variable names)
  const identifiers = block.content.match(/(?:function|class|interface|type|const|let|var|def|fn|func)\s+(\w+)/g);
  if (!identifiers || identifiers.length === 0) return { valid: true };

  // We just check the first identifier — if it exists somewhere in the codebase, the block is plausible
  const firstIdent = identifiers[0].split(/\s+/).pop();
  if (!firstIdent) return { valid: true };

  // Quick grep: check if the identifier exists in the src directory
  const { execFile } = await import('node:child_process');
  return new Promise((resolve) => {
    execFile('grep', ['-rl', firstIdent, '--include=*.ts', '--include=*.js', '--include=*.py', '--include=*.go', '--include=*.rs', '--include=*.java', '--include=*.rb', '--include=*.php', '-m', '1', rootPath], { maxBuffer: 1024 * 1024, timeout: 5000 }, (error, stdout) => {
      if (error || !stdout.trim()) {
        resolve({ valid: false, reason: `identifier \`${firstIdent}\` not found in source` });
      } else {
        resolve({ valid: true });
      }
    });
  });
}

// ─── Dimension Scorers ───────────────────────────────────

function scoreCompleteness(content: string, format: ConfigFormat): AuditDimensionScore {
  const findings: string[] = [];
  const lower = content.toLowerCase();
  const lines = content.split('\n');
  const headings = lines.filter(l => l.startsWith('#')).map(l => l.toLowerCase().replace(/^#+\s*/, ''));

  // Check for key sections coverage
  let sectionsFound = 0;
  const totalSections = Object.keys(CLAUDE_MD_SECTIONS).length;
  const missingSections: string[] = [];

  for (const [, config] of Object.entries(CLAUDE_MD_SECTIONS)) {
    const headingMatch = headings.some(h => config.keywords.some(kw => h.includes(kw)));
    const bodyMatches = config.keywords.filter(kw => lower.includes(kw)).length;
    const bodyScore = bodyMatches / Math.max(config.keywords.length * 0.4, 1);

    if (headingMatch || bodyScore > 0.5) {
      sectionsFound++;
    } else {
      missingSections.push(config.name);
    }
  }

  const sectionCoverage = (sectionsFound / totalSections) * 100;

  // Length bonus: longer configs tend to be more complete
  const lengthScore = Math.min(lines.length / 100, 1) * 20; // up to 20 pts for 100+ lines

  // Has code examples?
  const hasCodeBlocks = content.includes('```');
  const codeBlockBonus = hasCodeBlocks ? 10 : 0;

  // Has structured headings?
  const headingCount = headings.length;
  const structureBonus = Math.min(headingCount / 5, 1) * 10; // up to 10 pts for 5+ headings

  const score = Math.min(Math.round(sectionCoverage * 0.6 + lengthScore + codeBlockBonus + structureBonus), 100);

  if (missingSections.length > 0) {
    findings.push(`Missing sections: ${missingSections.join(', ')}`);
  }
  if (lines.length < 20) {
    findings.push(`Very short (${lines.length} lines) — likely incomplete`);
  }
  if (!hasCodeBlocks) {
    findings.push('No code examples found');
  }
  if (headingCount < 3) {
    findings.push('Minimal structure — fewer than 3 headings');
  }

  return { score, findings };
}

async function scoreAccuracy(content: string, rootPath: string): Promise<AuditDimensionScore> {
  const findings: string[] = [];

  // 1. Path validation
  const paths = extractPaths(content);
  let validPaths = 0;
  let invalidPaths = 0;
  const brokenPaths: string[] = [];

  for (const p of paths) {
    const fullPath = join(rootPath, p.path);
    if (await fileExists(fullPath)) {
      validPaths++;
    } else {
      invalidPaths++;
      brokenPaths.push(`Line ${p.line}: \`${p.path}\``);
    }
  }

  const pathAccuracy = paths.length > 0 ? (validPaths / paths.length) * 100 : 100;
  if (invalidPaths > 0) {
    findings.push(`${invalidPaths} broken path reference(s): ${brokenPaths.slice(0, 5).join('; ')}${brokenPaths.length > 5 ? ` ... and ${brokenPaths.length - 5} more` : ''}`);
  }

  // 2. Code block validation
  const codeBlocks = extractCodeBlocks(content);
  let validBlocks = 0;
  let invalidBlocks = 0;
  const brokenBlocks: string[] = [];

  for (const block of codeBlocks.slice(0, 10)) { // cap at 10 to keep fast
    const result = await validateCodeBlock(rootPath, block);
    if (result.valid) {
      validBlocks++;
    } else {
      invalidBlocks++;
      brokenBlocks.push(`Line ${block.line}: ${result.reason}`);
    }
  }

  const codeAccuracy = codeBlocks.length > 0 ? (validBlocks / Math.min(codeBlocks.length, 10)) * 100 : 100;
  if (invalidBlocks > 0) {
    findings.push(`${invalidBlocks} code block(s) reference identifiers not found in source: ${brokenBlocks.slice(0, 3).join('; ')}`);
  }

  // Blend: 60% path accuracy + 40% code block accuracy
  const score = Math.round(pathAccuracy * 0.6 + codeAccuracy * 0.4);
  return { score, findings };
}

async function scoreFreshness(configPath: string, rootPath: string): Promise<AuditDimensionScore> {
  const findings: string[] = [];

  const configMtime = await getFileMtime(configPath);
  if (!configMtime) {
    return { score: 0, findings: ['Config file not accessible'] };
  }

  // Get most recent repo activity via git
  let lastRepoActivity: Date | null = null;
  try {
    const { execFile } = await import('node:child_process');
    const gitDate = await new Promise<string>((resolve, reject) => {
      execFile('git', ['log', '-1', '--format=%ci'], { cwd: rootPath, timeout: 5000 }, (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout.trim());
      });
    });
    lastRepoActivity = new Date(gitDate);
  } catch {
    // Not a git repo or no commits — skip freshness check
    return { score: 80, findings: ['Cannot determine repo activity (not a git repo?)'] };
  }

  if (!lastRepoActivity) {
    return { score: 80, findings: ['No git commits found'] };
  }

  const configAge = Date.now() - configMtime.getTime();
  const repoAge = Date.now() - lastRepoActivity.getTime();
  const daysSinceConfigUpdate = Math.floor(configAge / (1000 * 60 * 60 * 24));
  const daysSinceRepoActivity = Math.floor(repoAge / (1000 * 60 * 60 * 24));

  // If config is newer than or similar age to repo's last commit, it's fresh
  const staleDays = daysSinceConfigUpdate - daysSinceRepoActivity;

  let score: number;
  if (staleDays <= 0) {
    score = 100; // Config updated more recently than last commit
  } else if (staleDays <= 7) {
    score = 90;
  } else if (staleDays <= 30) {
    score = 70;
    findings.push(`Config is ${staleDays} days behind latest repo activity`);
  } else if (staleDays <= 90) {
    score = 50;
    findings.push(`Config is ${staleDays} days behind latest repo activity — may be stale`);
  } else {
    score = Math.max(10, 50 - Math.floor(staleDays / 30) * 5);
    findings.push(`Config is ${staleDays} days behind latest repo activity — likely stale`);
  }

  findings.push(`Config last modified: ${daysSinceConfigUpdate}d ago | Repo last commit: ${daysSinceRepoActivity}d ago`);

  return { score, findings };
}

function scoreConsistency(
  content: string,
  allConfigs: Array<{ formatId: string; content: string }>,
): AuditDimensionScore {
  const findings: string[] = [];

  if (allConfigs.length < 2) {
    return { score: 100, findings: ['Only one config file — consistency N/A'] };
  }

  // Extract tech terms from this config
  const techTerms = ['typescript', 'javascript', 'python', 'react', 'vue', 'angular', 'svelte',
    'next.js', 'express', 'django', 'flask', 'rust', 'go', 'java', 'ruby',
    'postgresql', 'mysql', 'mongodb', 'redis', 'docker', 'kubernetes',
    'node', 'deno', 'bun', 'fastapi', 'spring', 'rails', 'laravel', 'php'];

  const lower = content.toLowerCase();
  const myTerms = new Set(techTerms.filter(t => lower.includes(t)));

  // Compare against other configs
  let contradictions = 0;
  for (const other of allConfigs) {
    if (other.content === content) continue;
    const otherLower = other.content.toLowerCase();
    const otherTerms = new Set(techTerms.filter(t => otherLower.includes(t)));

    // Find terms in one but not the other (potential inconsistency)
    for (const term of myTerms) {
      if (!otherTerms.has(term)) {
        // Only flag if the other config discusses the same category
        // (e.g., both mention languages, but differ on which)
        const mentions = (otherLower.match(new RegExp(term, 'gi')) || []).length;
        if (mentions === 0 && otherTerms.size > 0) {
          // Other config has tech terms but doesn't mention this one
          // Soft signal of inconsistency
          contradictions += 0.5;
        }
      }
    }
  }

  const score = Math.max(0, Math.round(100 - contradictions * 5));
  if (contradictions > 0) {
    findings.push(`${Math.ceil(contradictions)} potential tech stack inconsistency(ies) across config files`);
  }
  return { score, findings };
}

function scoreSpecificity(content: string): AuditDimensionScore {
  const findings: string[] = [];
  const lower = content.toLowerCase();
  const lines = content.split('\n');

  // Generic boilerplate indicators
  const genericPatterns = [
    /follow best practices/i,
    /write clean code/i,
    /use meaningful names/i,
    /keep it simple/i,
    /write tests for/i,
    /follow the existing/i,
    /use the latest/i,
    /ensure code quality/i,
  ];

  let genericCount = 0;
  for (const pattern of genericPatterns) {
    if (pattern.test(content)) genericCount++;
  }

  // Specific indicators: file paths, function names, specific patterns
  const specificIndicators = [
    /src\//i,                    // specific directory references
    /\.(ts|js|py|go|rs|java|rb|php)/i, // file extension references
    /import\s/i,                 // import statements
    /function\s+\w+/i,          // function references
    /class\s+\w+/i,             // class references
    /`[^`]+`/,                   // inline code
    /```/,                       // code blocks
    /\d+\s*lines?/i,            // specific numbers
    /port\s*\d+/i,              // port numbers
    /v\d+\.\d+/i,               // version numbers
  ];

  let specificCount = 0;
  for (const pattern of specificIndicators) {
    if (pattern.test(content)) specificCount++;
  }

  // Ratio: specific / (specific + generic)
  const totalSignals = specificCount + genericCount;
  const specificityRatio = totalSignals > 0 ? specificCount / totalSignals : 0.5;

  // Line count factor — very short configs are almost certainly generic
  const lengthFactor = Math.min(lines.length / 50, 1);

  // Project-specific terms (numbers, paths, names) vs total content
  const wordCount = content.split(/\s+/).length;
  const codeRefs = (content.match(/`[^`]+`/g) || []).length;
  const codeRefDensity = wordCount > 0 ? codeRefs / wordCount : 0;

  const score = Math.min(Math.round(
    specificityRatio * 50 +
    lengthFactor * 25 +
    Math.min(codeRefDensity * 1000, 25)
  ), 100);

  if (genericCount > 3) {
    findings.push(`High generic content ratio (${genericCount} boilerplate phrases detected)`);
  }
  if (lines.length < 20) {
    findings.push('Very short — likely not tailored to this codebase');
  }
  if (codeRefs < 3) {
    findings.push('Few inline code references — consider adding specific file paths, function names');
  }

  return { score, findings };
}

// ─── Main Audit Function ─────────────────────────────────

export interface AuditOptions {
  verbose: boolean;
  format: 'console' | 'json';
}

export async function runAudit(
  targetPath: string,
  options: AuditOptions,
): Promise<void> {
  const isJson = options.format === 'json';
  const log = isJson
    ? (...args: unknown[]) => console.error(...args)
    : console.log;

  log('');
  log(chalk.bold('  llm-sense audit') + ' — Config Quality Scoring');
  log(chalk.dim(`  Target: ${targetPath}`));
  log('');

  // Pre-flight
  if (!(await fileExists(targetPath))) {
    console.error(chalk.red(`  Error: Path not found: ${targetPath}`));
    process.exit(2);
  }

  // Detect all AI config files using the registry
  const existingFormats = await detectExistingFormats(targetPath);
  const allFormats = getAllFormats();

  // Also check CLAUDE.md directly (it may not be in the registry detection)
  const claudeMdPath = join(targetPath, 'CLAUDE.md');
  const hasClaudeMd = await fileExists(claudeMdPath);

  if (existingFormats.length === 0 && !hasClaudeMd) {
    log(chalk.yellow('  No AI config files found.'));
    log(chalk.dim(`  Run ${chalk.bold('llm-sense init')} to generate config files for 31+ AI tools.`));
    log('');

    if (isJson) {
      const result: AuditResult = {
        configs: [],
        aggregateScore: 0,
        grade: 'F',
        recommendations: ['Run `llm-sense init` to generate AI config files'],
        timestamp: new Date().toISOString(),
      };
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    }
    return;
  }

  // Deduplicate: CLAUDE.md is detected both directly and via registry
  const uniqueCount = hasClaudeMd
    ? existingFormats.filter(f => f.id !== 'claude').length + 1
    : existingFormats.length;
  log(chalk.dim(`  Found ${uniqueCount} AI config file(s)`));
  log('');

  // Load all config contents for cross-config consistency analysis
  const allConfigContents: Array<{ formatId: string; content: string }> = [];
  for (const format of existingFormats) {
    const content = await readFileSafe(join(targetPath, format.filePath));
    if (content) {
      allConfigContents.push({ formatId: format.id, content });
    }
  }
  if (hasClaudeMd) {
    const claudeContent = await readFileSafe(claudeMdPath);
    if (claudeContent && !allConfigContents.some(c => c.formatId === 'claude')) {
      allConfigContents.push({ formatId: 'claude', content: claudeContent });
    }
  }

  // Score each config file
  const auditResults: AuditConfigResult[] = [];

  // Build the list of configs to audit (CLAUDE.md + detected registry formats)
  const configsToAudit: Array<{ formatId: string; name: string; filePath: string; fullPath: string; format?: ConfigFormat }> = [];

  if (hasClaudeMd) {
    const claudeFormat = allFormats.find(f => f.id === 'claude');
    configsToAudit.push({
      formatId: 'claude',
      name: 'CLAUDE.md',
      filePath: 'CLAUDE.md',
      fullPath: claudeMdPath,
      format: claudeFormat,
    });
  }

  for (const format of existingFormats) {
    if (format.id === 'claude' && hasClaudeMd) continue; // already added
    configsToAudit.push({
      formatId: format.id,
      name: format.name,
      filePath: format.filePath,
      fullPath: join(targetPath, format.filePath),
      format,
    });
  }

  for (const config of configsToAudit) {
    const content = await readFileSafe(config.fullPath);
    if (!content) continue;

    const lines = content.split('\n').length;

    log(chalk.bold(`  ${config.name}`) + chalk.dim(` (${config.filePath})`));

    // Score all 5 dimensions
    const completeness = scoreCompleteness(content, config.format ?? allFormats[0]);
    const accuracy = await scoreAccuracy(content, targetPath);
    const freshness = await scoreFreshness(config.fullPath, targetPath);
    const consistency = scoreConsistency(content, allConfigContents);
    const specificity = scoreSpecificity(content);

    // Weighted aggregate: Accuracy most important, then Completeness, then rest
    const overallScore = Math.round(
      accuracy.score * 0.30 +
      completeness.score * 0.25 +
      freshness.score * 0.15 +
      consistency.score * 0.15 +
      specificity.score * 0.15
    );

    // Build recommendations
    const recommendations: string[] = [];
    if (completeness.score < 60) {
      const missing = completeness.findings.find(f => f.startsWith('Missing sections'));
      recommendations.push(missing ? `Add ${missing.replace('Missing sections: ', '')}` : 'Add more sections to improve completeness');
    }
    if (accuracy.score < 80) {
      for (const f of accuracy.findings) {
        if (f.includes('broken path')) {
          recommendations.push(`Fix broken path references in ${config.name}`);
          break;
        }
        if (f.includes('not found in source')) {
          recommendations.push(`Update code blocks in ${config.name} to match current source`);
          break;
        }
      }
    }
    if (freshness.score < 60) {
      recommendations.push(`Update ${config.name} — it may be out of date with recent changes`);
    }
    if (specificity.score < 50) {
      recommendations.push(`Make ${config.name} more specific — add file paths, function names, concrete examples`);
    }

    auditResults.push({
      file: config.name,
      filePath: config.filePath,
      formatId: config.formatId,
      exists: true,
      lines,
      overallScore,
      dimensions: { completeness, accuracy, freshness, consistency, specificity },
      recommendations,
    });

    // Console output
    const gradeColor = overallScore >= 70 ? chalk.green : overallScore >= 50 ? chalk.yellow : chalk.red;
    const bar = gradeColor('█'.repeat(Math.round(overallScore / 5))) + chalk.dim('░'.repeat(20 - Math.round(overallScore / 5)));
    log(`  ${bar} ${gradeColor(String(overallScore).padStart(3))}/100`);

    // Dimension breakdown
    const dims = [
      ['Completeness', completeness.score],
      ['Accuracy', accuracy.score],
      ['Freshness', freshness.score],
      ['Consistency', consistency.score],
      ['Specificity', specificity.score],
    ] as const;

    for (const [name, score] of dims) {
      const dimColor = score >= 70 ? chalk.green : score >= 50 ? chalk.yellow : chalk.red;
      log(`    ${name.padEnd(13)} ${dimColor(String(score).padStart(3))}`);
    }

    // Show findings if verbose
    if (options.verbose) {
      for (const dim of [completeness, accuracy, freshness, consistency, specificity]) {
        for (const finding of dim.findings) {
          log(chalk.dim(`    · ${finding}`));
        }
      }
    }

    // Show recommendations
    if (recommendations.length > 0) {
      for (const rec of recommendations.slice(0, 3)) {
        log(chalk.yellow(`    → ${rec}`));
      }
    }

    log('');
  }

  // Missing config file suggestions
  const missingTier1 = allFormats
    .filter(f => f.tier === 1 && !configsToAudit.some(c => c.formatId === f.id));
  const missingTier2 = allFormats
    .filter(f => f.tier === 2 && !configsToAudit.some(c => c.formatId === f.id))
    .slice(0, 3);

  const globalRecommendations: string[] = [];
  for (const missing of missingTier1) {
    globalRecommendations.push(`Create ${missing.filePath} (${missing.name}) — Tier 1 config missing`);
  }
  for (const missing of missingTier2) {
    globalRecommendations.push(`Consider creating ${missing.filePath} (${missing.name})`);
  }

  // Aggregate score
  const aggregateScore = auditResults.length > 0
    ? Math.round(auditResults.reduce((s, r) => s + r.overallScore, 0) / auditResults.length)
    : 0;
  const grade = aggregateScore >= 85 ? 'A' : aggregateScore >= 70 ? 'B' : aggregateScore >= 55 ? 'C' : aggregateScore >= 40 ? 'D' : 'F';

  // Summary
  log(chalk.bold('  Summary'));
  log('  ' + '─'.repeat(50));
  const aggColor = aggregateScore >= 70 ? chalk.green : aggregateScore >= 50 ? chalk.yellow : chalk.red;
  log(`  Aggregate Score: ${aggColor(chalk.bold(`${aggregateScore}/100`))} (Grade: ${aggColor(chalk.bold(grade))})`);
  log(`  Config Files: ${auditResults.length} audited, ${allFormats.length - auditResults.length} missing`);

  if (globalRecommendations.length > 0) {
    log('');
    log(chalk.bold('  Recommendations'));
    for (const rec of globalRecommendations) {
      log(chalk.yellow(`  → ${rec}`));
    }
  }

  // Suggest init --detect for missing configs
  if (missingTier1.length > 0) {
    log('');
    log(chalk.dim(`  Run ${chalk.bold('llm-sense init --detect')} to auto-generate missing config files`));
  }

  log('');

  // JSON output
  if (isJson) {
    const result: AuditResult = {
      configs: auditResults,
      aggregateScore,
      grade,
      recommendations: [
        ...auditResults.flatMap(r => r.recommendations),
        ...globalRecommendations,
      ],
      timestamp: new Date().toISOString(),
    };
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  }
}
