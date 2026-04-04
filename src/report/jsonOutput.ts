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
    estimatedEffort?: string;
    category: string;
    dependsOn?: string[];
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
  tokenHeatmap: {
    entries: Array<{ path: string; tokens: number; percentage: number; isContextHog: boolean }>;
    total: number;
    totalFiles: number;
  };
  configDrift: {
    totalReferences: number;
    validReferences: number;
    staleReferences: Array<{ file: string; line: number; reference: string; type: string; reason: string }>;
    freshnessScore: number;
  };
  security: {
    score: number;
    findings: Array<{ check: string; severity: string; detail: string; pointsDeducted: number }>;
  };
  meta: {
    duration: number;
    claudeModel: string;
    mode: 'full' | 'static-only';
    scoringVersion: string;
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
    version: '1.0.0',
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
      estimatedEffort: r.estimatedEffort,
      category: r.category,
      ...(r.dependsOn && r.dependsOn.length > 0 ? { dependsOn: r.dependsOn } : {}),
    })),
    tokenHeatmap: report.staticAnalysis.tokenHeatmap,
    configDrift: report.staticAnalysis.documentation.configDrift,
    security: {
      score: report.staticAnalysis.security.score,
      findings: report.staticAnalysis.security.findings,
    },
    empirical,
    meta: {
      duration: report.totalDurationMs,
      claudeModel: model ?? 'default',
      mode,
      scoringVersion: '0.9.0',
    },
  };
}

export function formatSummary(report: FinalReport): string {
  const delta = report.previousScore !== null
    ? ` (${report.overallScore - report.previousScore >= 0 ? '+' : ''}${report.overallScore - report.previousScore})`
    : '';
  return `${report.overallScore}/100 ${report.grade}${delta} ${report.targetPath}`;
}
