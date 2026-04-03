import { SCORING_WEIGHTS, SCORING_WEIGHTS_NO_EMPIRICAL } from '../constants.js';
import type { StaticAnalysisResult, TaskExecutionResult, CategoryScore } from '../types.js';

function clamp(value: number, min: number = 0, max: number = 100): number {
  return Math.round(Math.max(min, Math.min(max, value)));
}

export function scoreFileSizes(s: StaticAnalysisResult['fileSizes']): CategoryScore {
  if (s.totalFiles === 0) return { name: 'File Sizes', score: 100, weight: 0, findings: ['No source files found'], recommendations: [] };

  // Linear scale: 50-line median is perfect (100), 450+ is worst (0).
  // LLMs work best with focused files that fit comfortably in context.
  const medianScore = clamp(100 - ((s.medianLines - 50) / 4));
  // P90 measures the long tail: 100 lines = perfect, 1000+ = worst
  const p90Score = clamp(100 - ((s.p90Lines - 100) / 9));
  // Each 1000+ line file costs 5 pts (capped at 30) — these are "god files"
  const giantPenalty = Math.min(s.filesOver1000Lines * 5, 30);
  // 40% median + 40% P90 + 20% baseline minus giant file penalties
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

export function scoreStructure(s: StaticAnalysisResult['directoryStructure'], totalSourceFiles: number): CategoryScore {
  // Depth scoring is scaled by project size. A 20-file project at depth 2 is fine;
  // a 500-file project at depth 2 means everything is dumped in a few flat directories.
  // Small projects (<50 files): depth 2+ is ideal
  // Medium projects (50-200): depth 3+ is ideal
  // Large projects (200+): depth 3-6 is ideal
  let depthScore: number;
  const isSmallProject = totalSourceFiles < 50;
  const idealMinDepth = isSmallProject ? 2 : 3;

  if (s.maxDepth >= idealMinDepth && s.maxDepth <= 6) depthScore = 100;
  else if (s.maxDepth < idealMinDepth) depthScore = isSmallProject ? 80 : 60;
  else depthScore = clamp(100 - (s.maxDepth - 6) * 10);

  // 3-15 files per dir is the sweet spot for LLM directory listing comprehension.
  // Above 15 the LLM must read many file names to find what it needs.
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

  if (s.maxDepth < idealMinDepth && !isSmallProject) {
    recommendations.push(`Directory structure is too flat for a ${totalSourceFiles}-file project — add sub-directories to organize by domain or feature`);
  }
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

  if (score < 90 && s.inconsistencies.length > 0) {
    recommendations.push(`Standardize file naming to ${s.dominantConvention} convention`);
    for (const inc of s.inconsistencies.slice(0, 5)) {
      recommendations.push(`Rename: ${inc}`);
    }
  }

  return { name: 'Naming', score, weight: 0, findings, recommendations };
}

export function scoreDocumentation(s: StaticAnalysisResult['documentation']): CategoryScore {
  // Documentation scoring breakdown (100 total):
  //   README.md:              10 pts (5 exists + 5 if >50 lines)
  //   CLAUDE.md existence:    10 pts
  //   CLAUDE.md content:      40 pts (5 per section × 8 essential sections)
  //   Vibe coder AI configs:  10 pts (3 per tool detected, 2 bonus for .claude/)
  //   Inline comment ratio:   15 pts (scales linearly, maxes at 10% ratio)
  //   Baseline:               10 pts (any project with source files)
  //   Subdirectory CLAUDE.md:  5 pts (2 per file, capped)
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
  // Measures how well code is organized into cohesive modules.
  // Single-file directories suggest over-splitting; many-file directories suggest under-splitting.
  let score = 70; // baseline — most organized projects start here

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
  // Measures how much of the repo is useful code vs noise (generated files, binaries, lockfiles).
  // High noise means the LLM wastes tokens reading irrelevant files during exploration.
  let score = 70;

  // Source ratio thresholds — most real projects have 15-30% source files (the rest is
  // node_modules in git, assets, configs, etc). Only penalize extremes.
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

  // Average correctness across ALL tasks (failures count as 0.0)
  const avgCorrectness = taskResults.reduce((sum, r) => sum + r.correctnessScore, 0) / taskResults.length;

  // Efficiency bonus rewards codebases where tasks complete in fewer turns.
  const successful = taskResults.filter(r => r.success);
  const avgTurnRatio = successful.length > 0
    ? successful.reduce((sum, r) => sum + r.numTurns, 0) / (successful.length * 30)
    : 1;
  const efficiencyBonus = successRate > 0.5 ? (1 - avgTurnRatio) * 20 : 0;

  const score = clamp(successRate * 60 + avgCorrectness * 20 + efficiencyBonus);

  const findings = [
    `${successCount}/${taskResults.length} tasks completed successfully (${(successRate * 100).toFixed(0)}%)`,
    `Average file correctness: ${(avgCorrectness * 100).toFixed(0)}% (expected files touched)`,
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

  if (avgCorrectness < 0.5) {
    recommendations.push('Low file correctness — add CLAUDE.md with a module map so the LLM can find the right files');
  }

  return { name: 'Task Completion', score, weight: 0, findings, recommendations };
}

export function scoreTokenEfficiency(taskResults: TaskExecutionResult[], totalSourceFiles: number): CategoryScore {
  const successful = taskResults.filter(r => r.success);
  if (successful.length === 0) {
    return { name: 'Token Efficiency', score: 0, weight: 0, findings: ['No successful tasks to measure'], recommendations: [] };
  }

  const avgTokens = successful.reduce((sum, r) =>
    sum + r.tokenUsage.inputTokens + r.tokenUsage.outputTokens, 0) / successful.length;

  // Log-scaled baseline: expected tokens for a well-structured repo of this size.
  // Small repos (~20 files): ~40K tokens baseline
  // Medium repos (~200 files): ~66K tokens baseline
  // Large repos (~1000 files): ~85K tokens baseline
  const baselineTokens = 5000 + 8000 * Math.log2(Math.max(totalSourceFiles, 2));
  const ratio = avgTokens / baselineTokens;
  const score = clamp(100 - (ratio - 1) * 25);

  const findings = [
    `Avg tokens per successful task: ${Math.round(avgTokens).toLocaleString()} (baseline for ${totalSourceFiles}-file repo: ${Math.round(baselineTokens).toLocaleString()} — ${ratio.toFixed(1)}x)`,
    `Avg cost per task: $${(successful.reduce((s, r) => s + r.totalCostUsd, 0) / successful.length).toFixed(2)}`,
  ];
  const recommendations: string[] = [];

  if (ratio > 2) {
    recommendations.push('Token usage significantly exceeds baseline — codebase structure may be causing excessive context loading');
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
    { ...scoreStructure(staticResult.directoryStructure, staticResult.fileSizes.totalFiles), weight: weights.structure },
    { ...scoreModularity(staticResult.modularity), weight: weights.modularity },
    { ...scoreContextEfficiency(staticResult.noise), weight: weights.contextEfficiency },
    { ...scoreNaming(staticResult.naming), weight: weights.naming },
  ];

  if (!skipEmpirical) {
    categories.push(
      { ...scoreTaskCompletion(taskResults), weight: weights.taskCompletion },
      { ...scoreTokenEfficiency(taskResults, staticResult.fileSizes.totalFiles), weight: weights.tokenEfficiency },
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
