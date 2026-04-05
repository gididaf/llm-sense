import { execFile } from 'node:child_process';
import { relative, extname } from 'node:path';
import { SOURCE_EXTENSIONS } from '../constants.js';
import type { GitHistoryResult, FileImportance, Hotspot, KnowledgeConcentration, AstAnalysisResult } from '../types.js';

function exec(cmd: string, args: string[], cwd: string, timeout = 15000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, maxBuffer: 20 * 1024 * 1024, timeout }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${cmd} ${args.join(' ')} failed: ${stderr || error.message}`));
        return;
      }
      resolve(stdout);
    });
  });
}

// ─── File Importance Ranking ─────────────────────────────
// Inspired by Aider's PageRank approach: files that are changed frequently
// AND recently are more important for LLMs to understand first.

async function computeFileImportance(
  cwd: string,
  maxFiles: number = 100,
): Promise<FileImportance[]> {
  // Get commit frequency per file (last 6 months)
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
  const since = sixMonthsAgo.toISOString().split('T')[0];

  let logOutput: string;
  try {
    logOutput = await exec('git', ['log', '--since', since, '--name-only', '--pretty=format:', '--diff-filter=ACMR'], cwd);
  } catch {
    return [];
  }

  // Count frequency per file
  const frequency: Map<string, number> = new Map();
  for (const line of logOutput.split('\n')) {
    const file = line.trim();
    if (!file) continue;
    const ext = extname(file);
    if (!SOURCE_EXTENSIONS.has(ext)) continue;
    frequency.set(file, (frequency.get(file) ?? 0) + 1);
  }

  if (frequency.size === 0) return [];

  // Get last modification date per file
  const lastModified: Map<string, string> = new Map();
  try {
    const dateOutput = await exec('git', ['log', '--since', since, '--name-only', '--pretty=format:%ci', '--diff-filter=ACMR'], cwd);
    let currentDate = '';
    for (const line of dateOutput.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // Date lines match YYYY-MM-DD HH:MM:SS +ZZZZ
      if (/^\d{4}-\d{2}-\d{2}\s/.test(trimmed)) {
        currentDate = trimmed;
      } else if (currentDate && !lastModified.has(trimmed)) {
        lastModified.set(trimmed, currentDate);
      }
    }
  } catch {
    // Fall back — no dates
  }

  // Compute importance scores
  const maxFreq = Math.max(...frequency.values());
  const now = Date.now();
  const sixMonthsMs = 6 * 30 * 24 * 60 * 60 * 1000;

  const results: FileImportance[] = [];
  for (const [file, count] of frequency) {
    const frequencyScore = count / maxFreq;

    let recencyScore = 0.5; // default if no date
    const dateStr = lastModified.get(file);
    if (dateStr) {
      const fileDate = new Date(dateStr);
      const age = now - fileDate.getTime();
      recencyScore = Math.max(0, 1 - age / sixMonthsMs);
    }

    // Importance = 60% frequency + 40% recency
    const score = Math.round((frequencyScore * 0.6 + recencyScore * 0.4) * 100);

    results.push({
      path: file,
      score,
      commitCount: count,
      lastModified: dateStr ?? 'unknown',
      recencyScore: Math.round(recencyScore * 100) / 100,
      frequencyScore: Math.round(frequencyScore * 100) / 100,
    });
  }

  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, maxFiles);
}

// ─── Hotspot Detection ───────────────────────────────────
// Files with high change frequency AND low code health = hotspots.
// If we have AST complexity data, we use it. Otherwise, use line count as proxy.

function detectHotspots(
  fileImportance: FileImportance[],
  astResult?: AstAnalysisResult,
): Hotspot[] {
  // Build complexity map from AST data
  const complexityMap: Map<string, number> = new Map();
  if (astResult?.functions) {
    for (const fn of astResult.functions) {
      const existing = complexityMap.get(fn.file) ?? 0;
      complexityMap.set(fn.file, Math.max(existing, fn.cyclomaticComplexity));
    }
  }

  const hotspots: Hotspot[] = [];
  // Only consider files that changed at least 3 times
  const frequentFiles = fileImportance.filter(f => f.commitCount >= 3);

  for (const file of frequentFiles) {
    const complexity = complexityMap.get(file.path) ?? 0;

    // High churn threshold: top 25% by commit frequency
    const isHighChurn = file.frequencyScore > 0.5;

    // High complexity threshold: cyclomatic complexity >= 10
    const isHighComplexity = complexity >= 10;

    if (isHighChurn && isHighComplexity) {
      hotspots.push({
        path: file.path,
        changeFrequency: file.commitCount,
        complexity,
        risk: complexity >= 20 ? 'high' : 'medium',
      });
    } else if (isHighChurn && complexity >= 5) {
      hotspots.push({
        path: file.path,
        changeFrequency: file.commitCount,
        complexity,
        risk: 'low',
      });
    }
  }

  return hotspots
    .sort((a, b) => {
      const riskOrder = { high: 0, medium: 1, low: 2 };
      return riskOrder[a.risk] - riskOrder[b.risk] || b.changeFrequency - a.changeFrequency;
    })
    .slice(0, 20);
}

// ─── Knowledge Concentration (Bus Factor) ────────────────
// Detect files touched by only 1 author — bus factor risk.

async function computeKnowledgeConcentration(
  cwd: string,
  topFiles: FileImportance[],
): Promise<KnowledgeConcentration[]> {
  const results: KnowledgeConcentration[] = [];

  // Process top 50 files for author analysis
  const filesToCheck = topFiles.slice(0, 50);

  for (const file of filesToCheck) {
    try {
      // Use git log instead of git shortlog to avoid stdin-waiting issues
      const logOutput = await exec('git', ['log', '--format=%an', '--no-merges', '--', file.path], cwd, 5000);
      const authors = logOutput.split('\n').filter(Boolean);
      // Count per author
      const authorCounts = new Map<string, number>();
      for (const author of authors) {
        authorCounts.set(author, (authorCounts.get(author) ?? 0) + 1);
      }
      const authorEntries = [...authorCounts.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count);

      if (authorEntries.length === 0) continue;

      const totalCommits = authorEntries.reduce((s, e) => s + e.count, 0);
      const dominant = authorEntries[0];
      const dominantPct = Math.round((dominant.count / totalCommits) * 100);

      // Only flag if single author or dominant author has > 80% of commits
      if (authorEntries.length === 1 || dominantPct > 80) {
        results.push({
          path: file.path,
          authors: authorEntries.length,
          totalCommits,
          dominantAuthor: dominant.name,
          dominantAuthorPct: dominantPct,
        });
      }
    } catch {
      // Skip files that can't be analyzed
    }
  }

  return results
    .sort((a, b) => b.dominantAuthorPct - a.dominantAuthorPct)
    .slice(0, 20);
}

// ─── Convention Evolution ────────────────────────────────
// Track if naming conventions are improving over recent commits.

async function analyzeConventionTrend(
  cwd: string,
): Promise<GitHistoryResult['conventionTrend']> {
  // Get files changed in recent 30 commits vs older 30 commits
  let recentFiles: string[] = [];
  let olderFiles: string[] = [];

  try {
    const recentOutput = await exec('git', ['log', '--name-only', '--pretty=format:', '-30', '--diff-filter=A'], cwd);
    recentFiles = recentOutput.split('\n').map(l => l.trim()).filter(Boolean);
  } catch { /* no recent commits */ }

  try {
    const olderOutput = await exec('git', ['log', '--name-only', '--pretty=format:', '--skip=30', '-30', '--diff-filter=A'], cwd);
    olderFiles = olderOutput.split('\n').map(l => l.trim()).filter(Boolean);
  } catch { /* not enough history */ }

  if (recentFiles.length < 5 || olderFiles.length < 5) {
    return { direction: 'stable', recentConsistency: 0, olderConsistency: 0 };
  }

  // Analyze naming consistency: what fraction of source files follow a common convention?
  function conventionConsistency(files: string[]): number {
    const sourceFiles = files.filter(f => SOURCE_EXTENSIONS.has(extname(f)));
    if (sourceFiles.length === 0) return 0;

    const names = sourceFiles.map(f => f.split('/').pop()?.replace(extname(f), '') ?? '');
    // Detect dominant convention
    const camel = names.filter(n => /^[a-z][a-zA-Z0-9]*$/.test(n)).length;
    const pascal = names.filter(n => /^[A-Z][a-zA-Z0-9]*$/.test(n)).length;
    const snake = names.filter(n => /^[a-z][a-z0-9_]*$/.test(n) && n.includes('_')).length;
    const kebab = names.filter(n => /^[a-z][a-z0-9-]*$/.test(n) && n.includes('-')).length;

    const maxConvention = Math.max(camel, pascal, snake, kebab);
    return sourceFiles.length > 0 ? maxConvention / sourceFiles.length : 0;
  }

  const recentConsistency = Math.round(conventionConsistency(recentFiles) * 100);
  const olderConsistency = Math.round(conventionConsistency(olderFiles) * 100);

  let direction: 'improving' | 'stable' | 'degrading';
  const delta = recentConsistency - olderConsistency;
  if (delta > 10) direction = 'improving';
  else if (delta < -10) direction = 'degrading';
  else direction = 'stable';

  return { direction, recentConsistency, olderConsistency };
}

// ─── Churn + Complexity Correlation ──────────────────────

function computeChurnComplexity(
  fileImportance: FileImportance[],
  astResult?: AstAnalysisResult,
): GitHistoryResult['churnComplexityCorrelation'] {
  if (!astResult?.functions || astResult.functions.length === 0) return [];

  // Aggregate complexity per file
  const complexityMap: Map<string, number> = new Map();
  for (const fn of astResult.functions) {
    const existing = complexityMap.get(fn.file) ?? 0;
    complexityMap.set(fn.file, existing + fn.cyclomaticComplexity);
  }

  return fileImportance
    .filter(f => complexityMap.has(f.path))
    .map(f => ({
      path: f.path,
      churn: f.commitCount,
      complexity: complexityMap.get(f.path) ?? 0,
    }))
    .sort((a, b) => (b.churn * b.complexity) - (a.churn * a.complexity))
    .slice(0, 20);
}

// ─── Main Entry Point ────────────────────────────────────

export async function analyzeGitHistory(
  targetPath: string,
  verbose: boolean,
  astResult?: AstAnalysisResult,
): Promise<GitHistoryResult | null> {
  // Check if it's a git repo
  try {
    await exec('git', ['rev-parse', '--is-inside-work-tree'], targetPath);
  } catch {
    return null;
  }

  if (verbose) console.log('  Computing file importance...');
  const fileImportance = await computeFileImportance(targetPath);

  if (fileImportance.length === 0) {
    if (verbose) console.log('  No git history found (or no source file changes in last 6 months)');
    return null;
  }

  if (verbose) console.log('  Detecting hotspots...');
  const hotspots = detectHotspots(fileImportance, astResult);

  if (verbose) console.log('  Analyzing knowledge concentration...');
  const knowledgeConcentration = await computeKnowledgeConcentration(targetPath, fileImportance);

  if (verbose) console.log('  Analyzing convention trends...');
  const conventionTrend = await analyzeConventionTrend(targetPath);

  if (verbose) console.log('  Computing churn × complexity...');
  const churnComplexityCorrelation = computeChurnComplexity(fileImportance, astResult);

  // Get timespan
  let oldest = '';
  let newest = '';
  try {
    oldest = (await exec('git', ['log', '--reverse', '--format=%ci', '-1'], targetPath)).trim();
    newest = (await exec('git', ['log', '--format=%ci', '-1'], targetPath)).trim();
  } catch { /* skip */ }

  // Count total commits analyzed
  let totalCommitsAnalyzed = 0;
  try {
    const countOutput = await exec('git', ['rev-list', '--count', 'HEAD'], targetPath);
    totalCommitsAnalyzed = parseInt(countOutput.trim(), 10) || 0;
  } catch { /* skip */ }

  return {
    fileImportance,
    hotspots,
    knowledgeConcentration,
    conventionTrend,
    churnComplexityCorrelation,
    totalCommitsAnalyzed,
    timespan: { oldest, newest },
  };
}
