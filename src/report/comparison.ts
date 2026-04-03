import type { CategoryScore } from '../types.js';

export interface ComparisonRepo {
  path: string;
  name: string;
  overallScore: number;
  grade: string;
  categories: CategoryScore[];
}

export interface ComparisonResult {
  repos: [ComparisonRepo, ComparisonRepo];
  categoryComparison: Array<{
    name: string;
    scoreA: number;
    scoreB: number;
    winner: string;
  }>;
  overallWinner: string;
}

export function buildComparison(a: ComparisonRepo, b: ComparisonRepo): ComparisonResult {
  const categoryComparison: ComparisonResult['categoryComparison'] = [];

  // Build a map of categories for each repo
  const catsA = new Map(a.categories.map(c => [c.name, c.score]));
  const catsB = new Map(b.categories.map(c => [c.name, c.score]));

  // Union of all category names
  const allNames = new Set([...catsA.keys(), ...catsB.keys()]);

  for (const name of allNames) {
    const scoreA = catsA.get(name) ?? 0;
    const scoreB = catsB.get(name) ?? 0;
    const winner = scoreA > scoreB ? a.name : scoreB > scoreA ? b.name : 'tie';
    categoryComparison.push({ name, scoreA, scoreB, winner });
  }

  // Sort by largest difference
  categoryComparison.sort((x, y) => Math.abs(y.scoreA - y.scoreB) - Math.abs(x.scoreA - x.scoreB));

  const overallWinner = a.overallScore > b.overallScore ? a.name
    : b.overallScore > a.overallScore ? b.name
    : 'tie';

  return {
    repos: [a, b],
    categoryComparison,
    overallWinner,
  };
}

export function formatComparisonMarkdown(result: ComparisonResult): string {
  const [a, b] = result.repos;
  const lines: string[] = [];

  lines.push(`  Comparison: ${a.name} vs ${b.name}`);
  lines.push('');

  // Overall scores
  const winnerLabel = result.overallWinner === 'tie' ? 'Tie' : `Winner: ${result.overallWinner}`;
  lines.push(`  Overall: ${a.name} ${a.overallScore}/100 (${a.grade})  vs  ${b.name} ${b.overallScore}/100 (${b.grade})  [${winnerLabel}]`);
  lines.push('');

  // Category table
  const nameWidth = Math.max(...result.categoryComparison.map(c => c.name.length), 8);
  const colA = a.name.length > 12 ? a.name.slice(0, 12) : a.name;
  const colB = b.name.length > 12 ? b.name.slice(0, 12) : b.name;

  lines.push(`  ${'Category'.padEnd(nameWidth)}  ${colA.padStart(12)}  ${colB.padStart(12)}  Winner`);
  lines.push('  ' + '─'.repeat(nameWidth + 42));

  for (const cat of result.categoryComparison) {
    const delta = cat.scoreA - cat.scoreB;
    const deltaStr = delta > 0 ? `(+${delta})` : delta < 0 ? `(${delta})` : '';
    lines.push(`  ${cat.name.padEnd(nameWidth)}  ${String(cat.scoreA).padStart(12)}  ${String(cat.scoreB).padStart(12)}  ${cat.winner} ${deltaStr}`);
  }

  lines.push('  ' + '─'.repeat(nameWidth + 42));
  lines.push('');

  return lines.join('\n');
}

export function formatComparisonJson(result: ComparisonResult): object {
  const [a, b] = result.repos;
  return {
    comparison: {
      repoA: { name: a.name, path: a.path, score: a.overallScore, grade: a.grade },
      repoB: { name: b.name, path: b.path, score: b.overallScore, grade: b.grade },
      winner: result.overallWinner,
      categories: result.categoryComparison,
    },
  };
}
