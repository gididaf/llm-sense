import { SCORING_WEIGHTS, SCORING_WEIGHTS_NO_EMPIRICAL } from '../constants.js';
import type { StaticAnalysisResult, TaskExecutionResult, CategoryScore } from '../types.js';

function clamp(value: number, min: number = 0, max: number = 100): number {
  return Math.round(Math.max(min, Math.min(max, value)));
}

export function scoreFileSizes(s: StaticAnalysisResult['fileSizes']): CategoryScore {
  if (s.totalFiles === 0) return { name: 'File Sizes', score: 100, weight: 0, findings: ['No source files found'], recommendations: [] };

  // Median: 50 lines = 100, 450 lines = 0
  const medianScore = clamp(100 - ((s.medianLines - 50) / 4));
  // P90: 100 lines = 100, 1000 lines = 0
  const p90Score = clamp(100 - ((s.p90Lines - 100) / 9));
  // Penalty for giant files
  const giantPenalty = Math.min(s.filesOver1000Lines * 5, 30);
  const score = clamp(medianScore * 0.4 + p90Score * 0.4 + 20 - giantPenalty);

  const findings: string[] = [];
  const recommendations: string[] = [];

  findings.push(`Median file: ${s.medianLines} lines, P90: ${s.p90Lines} lines`);
  if (s.filesOver1000Lines > 0) {
    findings.push(`${s.filesOver1000Lines} files over 1,000 lines`);
    for (const f of s.largestFiles.slice(0, 3)) {
      recommendations.push(`Split \`${f.path}\` (${f.lines.toLocaleString()} lines) into smaller modules`);
    }
  }
  if (s.medianLines > 200) {
    recommendations.push('Aim for median file size under 200 lines for optimal LLM context efficiency');
  }

  return { name: 'File Sizes', score, weight: 0, findings, recommendations };
}

export function scoreStructure(s: StaticAnalysisResult['directoryStructure']): CategoryScore {
  // Depth: 3-5 = ideal, >8 = too deep, <2 = too flat
  let depthScore: number;
  if (s.maxDepth >= 3 && s.maxDepth <= 6) depthScore = 100;
  else if (s.maxDepth <= 2) depthScore = 60;
  else depthScore = clamp(100 - (s.maxDepth - 6) * 10);

  // Files per dir: 3-15 = ideal
  let filesPerDirScore: number;
  if (s.avgFilesPerDir >= 3 && s.avgFilesPerDir <= 15) filesPerDirScore = 100;
  else if (s.avgFilesPerDir > 15) filesPerDirScore = clamp(100 - (s.avgFilesPerDir - 15) * 3);
  else filesPerDirScore = 70;

  const score = clamp(depthScore * 0.5 + filesPerDirScore * 0.5);

  const findings: string[] = [
    `Max depth: ${s.maxDepth}, avg depth: ${s.avgDepth}`,
    `Avg ${s.avgFilesPerDir} files per directory`,
  ];
  const recommendations: string[] = [];

  if (s.maxDepth > 8) recommendations.push('Reduce directory nesting — deep paths are harder for LLMs to navigate');
  if (s.maxFilesInDir.count > 30) {
    recommendations.push(`Split \`${s.maxFilesInDir.path}\` (${s.maxFilesInDir.count} files) into sub-directories`);
  }

  return { name: 'Structure', score, weight: 0, findings, recommendations };
}

export function scoreNaming(s: StaticAnalysisResult['naming']): CategoryScore {
  const score = s.conventionScore;

  const findings = [`Dominant convention: ${s.dominantConvention}, ${score}% consistency`];
  const recommendations: string[] = [];

  if (score < 80) {
    recommendations.push(`Standardize file naming to ${s.dominantConvention} convention`);
    for (const inc of s.inconsistencies.slice(0, 3)) {
      recommendations.push(`Rename: ${inc}`);
    }
  }

  return { name: 'Naming', score, weight: 0, findings, recommendations };
}

export function scoreDocumentation(s: StaticAnalysisResult['documentation']): CategoryScore {
  let score = 0;
  const findings: string[] = [];
  const recommendations: string[] = [];

  // README.md: 10 pts
  if (s.hasReadme) {
    score += 5;
    if (s.readmeLines > 50) score += 5;
    findings.push(`README.md: ${s.readmeLines} lines`);
  } else {
    recommendations.push('Add a README.md with project overview, setup instructions, and architecture notes');
  }

  // CLAUDE.md existence: 10 pts
  if (s.hasClaudeMd) {
    score += 10;
    findings.push(`CLAUDE.md: ${s.claudeMdLines} lines`);
  } else {
    recommendations.push('Create a CLAUDE.md with LLM-specific guidance — this is the single highest-impact improvement for LLM-friendliness');
  }

  // CLAUDE.md content quality: 40 pts (5 per section x 8 sections)
  if (s.claudeMdContent) {
    const sectionEntries = Object.entries(s.claudeMdContent.sections);
    for (const [key, section] of sectionEntries) {
      score += Math.round(section.score * 5);
    }
    const foundSections = sectionEntries.filter(([, v]) => v.found).map(([k]) => k);
    const missingSections = s.claudeMdContent.missingSections;

    findings.push(`CLAUDE.md sections: ${foundSections.length}/8 detected (score: ${s.claudeMdContent.overallContentScore}/100)`);

    if (missingSections.length > 0) {
      findings.push(`Missing sections: ${missingSections.join(', ')}`);
      for (const section of missingSections) {
        recommendations.push(`Add "${section}" section to CLAUDE.md`);
      }
    }
  } else if (!s.hasClaudeMd) {
    // No CLAUDE.md at all — 0 out of 40 content points
    findings.push('No CLAUDE.md — missing all 8 recommended sections');
  }

  // Vibe coder context files: 10 pts
  const vc = s.vibeCoderContext;
  if (vc.detectedTools.length > 0) {
    findings.push(`AI tools detected: ${vc.detectedTools.join(', ')}`);
    score += Math.min(vc.detectedTools.length * 3, 10);
  }
  if (vc.hasClaudeDir) score += 2;
  score = Math.min(score, score); // cap context points contribution

  if (vc.subdirectoryClaudeMdPaths.length > 0) {
    findings.push(`Subdirectory CLAUDE.md files: ${vc.subdirectoryClaudeMdPaths.join(', ')}`);
    score += Math.min(vc.subdirectoryClaudeMdPaths.length * 2, 5);
  }

  // Inline comment ratio: 15 pts
  score += Math.min(Math.round(s.inlineCommentRatio * 150), 15);
  findings.push(`Inline comment ratio: ${(s.inlineCommentRatio * 100).toFixed(1)}%`);

  if (s.inlineCommentRatio < 0.05) {
    recommendations.push('Add more inline comments to explain non-obvious logic');
  }

  // Baseline: 10 pts for having any source files
  if (s.totalSourceFiles > 0) score += 10;

  score = clamp(score);

  return { name: 'Documentation', score, weight: 0, findings, recommendations };
}

export function scoreModularity(s: StaticAnalysisResult['modularity']): CategoryScore {
  // Ideal: 3-10 files per directory, few single-file directories
  let score = 70; // baseline

  if (s.avgFilesPerDirectory >= 3 && s.avgFilesPerDirectory <= 10) score += 15;
  else if (s.avgFilesPerDirectory > 10) score -= Math.min((s.avgFilesPerDirectory - 10) * 2, 20);

  const singleFileDirRatio = s.totalDirectories > 0 ? s.singleFileDirectories / s.totalDirectories : 0;
  if (singleFileDirRatio > 0.4) score -= 10;
  if (singleFileDirRatio < 0.2) score += 10;

  if (s.barrelExportCount > 0) score += 5;

  score = clamp(score);

  const findings = [
    `Avg ${s.avgFilesPerDirectory} files/dir, ${s.singleFileDirectories} single-file dirs`,
    `${s.barrelExportCount} barrel export files (index.ts/js)`,
  ];
  const recommendations: string[] = [];

  if (s.maxFilesInDirectory.count > 20) {
    recommendations.push(`\`${s.maxFilesInDirectory.path}\` has ${s.maxFilesInDirectory.count} files — consider splitting into sub-modules`);
  }
  if (singleFileDirRatio > 0.3) {
    recommendations.push('Many single-file directories — consider consolidating small modules');
  }

  return { name: 'Modularity', score, weight: 0, findings, recommendations };
}

export function scoreContextEfficiency(s: StaticAnalysisResult['noise']): CategoryScore {
  // Start at 70 (baseline for any organized project)
  let score = 70;

  // Source ratio: penalize only if extremely low (<10%)
  if (s.sourceToNoiseRatio < 0.10) score -= 20;
  else if (s.sourceToNoiseRatio < 0.20) score -= 5;
  else if (s.sourceToNoiseRatio > 0.50) score += 15;
  else if (s.sourceToNoiseRatio > 0.30) score += 5;

  // Penalty for many generated files in the repo
  const genPenalty = Math.min(s.generatedFileCount * 1, 15);
  score -= genPenalty;

  // Moderate penalty for many binary files (normal to have some)
  if (s.binaryFileCount > 50) score -= 10;
  else if (s.binaryFileCount > 20) score -= 5;

  score = clamp(score);

  const findings = [
    `${s.sourceFiles} source files / ${s.totalFiles} total (${(s.sourceToNoiseRatio * 100).toFixed(0)}%)`,
    `${s.generatedFileCount} generated files, ${s.binaryFileCount} binary files`,
  ];
  const recommendations: string[] = [];

  if (s.lockfileBytes > 500_000) {
    recommendations.push('Large lockfiles add noise — ensure .gitignore or LLM config excludes them from context');
  }
  if (s.generatedFileCount > 10) {
    recommendations.push('Many generated files — ensure they are excluded from LLM context via .gitignore or CLAUDE.md guidance');
  }

  return { name: 'Context Efficiency', score, weight: 0, findings, recommendations };
}

export function scoreTaskCompletion(taskResults: TaskExecutionResult[]): CategoryScore {
  if (taskResults.length === 0) {
    return { name: 'Task Completion', score: 0, weight: 0, findings: ['No empirical tasks run'], recommendations: [] };
  }

  const successCount = taskResults.filter(r => r.success).length;
  const successRate = successCount / taskResults.length;

  // Bonus for efficient completion (fewer turns used relative to max)
  const successful = taskResults.filter(r => r.success);
  const avgTurnRatio = successful.length > 0
    ? successful.reduce((sum, r) => sum + r.numTurns, 0) / (successful.length * 30) // assuming 30 max turns
    : 1;
  const efficiencyBonus = successRate > 0.5 ? (1 - avgTurnRatio) * 20 : 0;

  const score = clamp(successRate * 80 + efficiencyBonus);

  const findings = [
    `${successCount}/${taskResults.length} tasks completed successfully (${(successRate * 100).toFixed(0)}%)`,
    `Avg turns: ${(taskResults.reduce((s, r) => s + r.numTurns, 0) / taskResults.length).toFixed(1)}`,
  ];
  const recommendations: string[] = [];

  const failed = taskResults.filter(r => !r.success);
  if (failed.length > 0) {
    recommendations.push(`${failed.length} tasks failed — review codebase structure in affected areas`);
    for (const f of failed.slice(0, 3)) {
      recommendations.push(`Task "${f.taskTitle}" failed: ${f.errors[0] || f.stopReason}`);
    }
  }

  return { name: 'Task Completion', score, weight: 0, findings, recommendations };
}

export function scoreTokenEfficiency(taskResults: TaskExecutionResult[]): CategoryScore {
  const successful = taskResults.filter(r => r.success);
  if (successful.length === 0) {
    return { name: 'Token Efficiency', score: 0, weight: 0, findings: ['No successful tasks to measure'], recommendations: [] };
  }

  const avgTokens = successful.reduce((sum, r) =>
    sum + r.tokenUsage.inputTokens + r.tokenUsage.outputTokens, 0) / successful.length;

  // 10k tokens = 100, 100k = 50, 500k+ = 0
  const score = clamp(100 - ((avgTokens - 10000) / 5000));

  const findings = [
    `Avg tokens per successful task: ${Math.round(avgTokens).toLocaleString()}`,
    `Avg cost per task: $${(successful.reduce((s, r) => s + r.totalCostUsd, 0) / successful.length).toFixed(2)}`,
  ];
  const recommendations: string[] = [];

  if (avgTokens > 50000) {
    recommendations.push('High token usage per task — codebase structure may be causing excessive context loading');
    recommendations.push('Consider adding CLAUDE.md with clear module boundaries and common patterns');
  }

  return { name: 'Token Efficiency', score, weight: 0, findings, recommendations };
}

export function computeScores(
  staticResult: StaticAnalysisResult,
  taskResults: TaskExecutionResult[],
  skipEmpirical: boolean,
): { categories: CategoryScore[]; overallScore: number; grade: string } {
  const weights = skipEmpirical ? SCORING_WEIGHTS_NO_EMPIRICAL : SCORING_WEIGHTS;

  const categories: CategoryScore[] = [
    { ...scoreDocumentation(staticResult.documentation), weight: weights.documentation },
    { ...scoreFileSizes(staticResult.fileSizes), weight: weights.fileSizes },
    { ...scoreStructure(staticResult.directoryStructure), weight: weights.structure },
    { ...scoreModularity(staticResult.modularity), weight: weights.modularity },
    { ...scoreContextEfficiency(staticResult.noise), weight: weights.contextEfficiency },
    { ...scoreNaming(staticResult.naming), weight: weights.naming },
  ];

  if (!skipEmpirical) {
    categories.push(
      { ...scoreTaskCompletion(taskResults), weight: weights.taskCompletion },
      { ...scoreTokenEfficiency(taskResults), weight: weights.tokenEfficiency },
    );
  }

  const overallScore = Math.round(
    categories.reduce((sum, cat) => sum + cat.score * cat.weight, 0),
  );

  const grade = overallScore >= 85 ? 'A'
    : overallScore >= 70 ? 'B'
    : overallScore >= 55 ? 'C'
    : overallScore >= 40 ? 'D'
    : 'F';

  return { categories, overallScore, grade };
}
