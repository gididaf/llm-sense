import { SCORING_VERSION } from '../constants.js';
import { buildAnnotations, type Annotation } from './annotations.js';
import type { TokenOptimizationResult } from '../analyzers/tokenOptimization.js';
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
    byDifficulty: {
      easy: { total: number; succeeded: number };
      medium: { total: number; succeeded: number };
      hard: { total: number; succeeded: number };
    };
    tasks: Array<{
      id: string;
      type: string;
      difficulty: string;
      title: string;
      success: boolean;
      turns: number;
      cost: number;
      correctness: number;
    }>;
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
  contextProfile?: {
    totalSourceTokens: number;
    tiers: Array<{ windowSize: number; label: string; coverage: number; verdict: string }>;
    recommendedMinimum: string;
    bestExperience: string;
    topConsumers: Array<{ path: string; percentage: number; tokens: number }>;
  };
  languageChecks?: Array<{
    language: string;
    totalPenalty: number;
    filesScanned: number;
    checks: Array<{ name: string; occurrences: number; penalty: number }>;
  }>;
  gitHistory?: {
    fileImportance: Array<{ path: string; score: number; commitCount: number; lastModified: string }>;
    hotspots: Array<{ path: string; changeFrequency: number; complexity: number; risk: string }>;
    knowledgeConcentration: Array<{ path: string; authors: number; dominantAuthor: string; dominantAuthorPct: number }>;
    conventionTrend: { direction: string; recentConsistency: number; olderConsistency: number };
    totalCommitsAnalyzed: number;
  };
  annotations?: Array<{
    file: string;
    line?: number;
    severity: 'error' | 'warning' | 'info';
    category: string;
    message: string;
  }>;
  tokenOptimization?: {
    potentialSavings: { excludeTokens: number; compressTokens: number; totalTokens: number; savingsPercent: number };
    excludeRecommendations: Array<{ path: string; tokens: number; reason: string; pattern: string }>;
    compressRecommendations: Array<{ path: string; tokens: number; estimatedCompressedTokens: number; reason: string; strategy: string }>;
  };
  llmLint?: {
    findings: Array<{
      ruleId: string;
      ruleName: string;
      severity: string;
      category: string;
      file: string;
      functionName: string;
      startLine: number;
      endLine: number;
      explanation: string;
      suggestedFix: string;
    }>;
    rulesEvaluated: number;
    candidatesEvaluated: number;
    filesScanned: number;
    totalCostUsd: number;
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
  includeAnnotations?: boolean,
  tokenOptimization?: TokenOptimizationResult,
): LlmSenseJsonOutput {
  const delta = report.previousScore !== null
    ? report.overallScore - report.previousScore
    : null;

  let empirical: LlmSenseJsonOutput['empirical'] = null;
  if (report.taskResults.length > 0) {
    const successCount = report.taskResults.filter(r => r.success).length;
    const avgTurns = report.taskResults.reduce((s, r) => s + r.numTurns, 0) / report.taskResults.length;
    const avgCost = report.taskResults.reduce((s, r) => s + r.totalCostUsd, 0) / report.taskResults.length;

    const byDifficulty = { easy: { total: 0, succeeded: 0 }, medium: { total: 0, succeeded: 0 }, hard: { total: 0, succeeded: 0 } };
    for (const r of report.taskResults) {
      byDifficulty[r.taskDifficulty].total++;
      if (r.success) byDifficulty[r.taskDifficulty].succeeded++;
    }

    empirical = {
      enabled: true,
      tasksRun: report.taskResults.length,
      tasksSucceeded: successCount,
      successRate: successCount / report.taskResults.length,
      avgTurns,
      avgCost,
      totalCost: report.totalCostUsd,
      byDifficulty,
      tasks: report.taskResults.map(r => ({
        id: r.taskId,
        type: r.taskType,
        difficulty: r.taskDifficulty,
        title: r.taskTitle,
        success: r.success,
        turns: r.numTurns,
        cost: r.totalCostUsd,
        correctness: r.correctnessScore,
      })),
    };
  }

  return {
    version: '1.3.0',
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
    contextProfile: report.staticAnalysis.contextProfile ?? undefined,
    languageChecks: report.staticAnalysis.languageChecks?.map(lc => ({
      language: lc.language,
      totalPenalty: lc.totalPenalty,
      filesScanned: lc.filesScanned,
      checks: lc.checks.filter(c => c.occurrences > 0).map(c => ({
        name: c.name,
        occurrences: c.occurrences,
        penalty: Math.min(c.occurrences * c.penalty, c.cap),
      })),
    })).filter(lc => lc.checks.length > 0) ?? undefined,
    gitHistory: report.staticAnalysis.gitHistory ? {
      fileImportance: report.staticAnalysis.gitHistory.fileImportance.map(f => ({
        path: f.path, score: f.score, commitCount: f.commitCount, lastModified: f.lastModified,
      })),
      hotspots: report.staticAnalysis.gitHistory.hotspots.map(h => ({
        path: h.path, changeFrequency: h.changeFrequency, complexity: h.complexity, risk: h.risk,
      })),
      knowledgeConcentration: report.staticAnalysis.gitHistory.knowledgeConcentration.map(k => ({
        path: k.path, authors: k.authors, dominantAuthor: k.dominantAuthor, dominantAuthorPct: k.dominantAuthorPct,
      })),
      conventionTrend: report.staticAnalysis.gitHistory.conventionTrend,
      totalCommitsAnalyzed: report.staticAnalysis.gitHistory.totalCommitsAnalyzed,
    } : undefined,
    annotations: includeAnnotations ? buildAnnotations(report.staticAnalysis) : undefined,
    tokenOptimization: tokenOptimization ? {
      potentialSavings: tokenOptimization.potentialSavings,
      excludeRecommendations: tokenOptimization.excludeRecommendations.slice(0, 20),
      compressRecommendations: tokenOptimization.compressRecommendations.slice(0, 10),
    } : undefined,
    llmLint: report.llmLint ?? undefined,
    empirical,
    meta: {
      duration: report.totalDurationMs,
      claudeModel: model ?? 'default',
      mode,
      scoringVersion: SCORING_VERSION,
    },
  };
}

export function formatSummary(report: FinalReport): string {
  const delta = report.previousScore !== null
    ? ` (${report.overallScore - report.previousScore >= 0 ? '+' : ''}${report.overallScore - report.previousScore})`
    : '';
  return `${report.overallScore}/100 ${report.grade}${delta} ${report.targetPath}`;
}
