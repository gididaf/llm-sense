import type { FinalReport } from '../types.js';

export interface LlmSenseJsonOutput {
  version: string;
  timestamp: string;
  target: string;
  score: number;
  grade: string;
  previousScore: number | null;
  delta: number | null;
  categories: Array<{
    name: string;
    score: number;
    weight: number;
    weighted: number;
    findings: string[];
  }>;
  recommendations: Array<{
    id: string;
    title: string;
    priority: 1 | 2 | 3;
    estimatedScoreImpact: number;
    category: string;
  }>;
  empirical: {
    enabled: boolean;
    tasksRun: number;
    tasksSucceeded: number;
    successRate: number;
    avgTurns: number;
    avgCost: number;
    totalCost: number;
  } | null;
  meta: {
    duration: number;
    claudeModel: string;
    mode: 'full' | 'static-only';
  };
}

export function buildJsonOutput(
  report: FinalReport,
  mode: 'full' | 'static-only',
  model?: string,
): LlmSenseJsonOutput {
  const delta = report.previousScore !== null
    ? report.overallScore - report.previousScore
    : null;

  let empirical: LlmSenseJsonOutput['empirical'] = null;
  if (report.taskResults.length > 0) {
    const successCount = report.taskResults.filter(r => r.success).length;
    const avgTurns = report.taskResults.reduce((s, r) => s + r.numTurns, 0) / report.taskResults.length;
    const avgCost = report.taskResults.reduce((s, r) => s + r.totalCostUsd, 0) / report.taskResults.length;
    empirical = {
      enabled: true,
      tasksRun: report.taskResults.length,
      tasksSucceeded: successCount,
      successRate: successCount / report.taskResults.length,
      avgTurns,
      avgCost,
      totalCost: report.totalCostUsd,
    };
  }

  return {
    version: '0.8.0',
    timestamp: report.generatedAt,
    target: report.targetPath,
    score: report.overallScore,
    grade: report.grade,
    previousScore: report.previousScore,
    delta,
    categories: report.categories.map(c => ({
      name: c.name,
      score: c.score,
      weight: c.weight,
      weighted: Math.round(c.score * c.weight * 10) / 10,
      findings: c.findings,
    })),
    recommendations: report.recommendations.map(r => ({
      id: r.id,
      title: r.title,
      priority: r.priority,
      estimatedScoreImpact: r.estimatedScoreImpact,
      category: r.category,
    })),
    empirical,
    meta: {
      duration: report.totalDurationMs,
      claudeModel: model ?? 'default',
      mode,
    },
  };
}

export function formatSummary(report: FinalReport): string {
  const delta = report.previousScore !== null
    ? ` (${report.overallScore - report.previousScore >= 0 ? '+' : ''}${report.overallScore - report.previousScore})`
    : '';
  return `${report.overallScore}/100 ${report.grade}${delta} ${report.targetPath}`;
}
