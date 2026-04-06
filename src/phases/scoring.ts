import { SCORING_WEIGHTS, SCORING_WEIGHTS_NO_EMPIRICAL, SCORING_PROFILES, DIFFICULTY_WEIGHTS } from '../constants.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { StaticAnalysisResult, TaskExecutionResult, CategoryScore, LanguageCheckResult, AstAnalysisResult, FinalReport } from '../types.js';

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
  // Each 1000+ line CODE file costs 5 pts (capped at 30) — these are "god files"
  // Data files and vendored files are excluded since they need context exclusion, not splitting
  const giantPenalty = Math.min(s.codeFilesOver1000Lines * 5, 30);
  // 40% median + 40% P90 + 20% baseline minus giant file penalties
  const score = clamp(medianScore * 0.4 + p90Score * 0.4 + 20 - giantPenalty);

  const findings: string[] = [];
  const recommendations: string[] = [];

  findings.push(`Median file: ${s.medianLines} lines, P90: ${s.p90Lines} lines`);
  if (s.filesOver1000Lines > 0) {
    const excluded = s.filesOver1000Lines - s.codeFilesOver1000Lines;
    findings.push(`${s.filesOver1000Lines} files over 1,000 lines${excluded > 0 ? ` (${excluded} data/vendored excluded from scoring)` : ''}`);
    for (const f of s.largestFiles.filter(f => f.classification === 'code').slice(0, 3)) {
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

  const findings = [`${score}% per-directory naming consistency`];
  const recommendations: string[] = [];

  if (score < 90 && s.inconsistencies.length > 0) {
    recommendations.push(`Fix ${s.inconsistencies.length} naming inconsistencies`);
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
  // If CLAUDE.md exists and is comprehensive (4+ sections), README is redundant for LLMs —
  // award the points anyway since the LLM already has project orientation via CLAUDE.md.
  const hasComprehensiveClaudeMd = s.hasClaudeMd && s.claudeMdContent && s.claudeMdContent.missingSections.length <= 4;
  if (s.hasReadme) {
    score += 5;
    if (s.readmeLines > 50) score += 5;
    findings.push(`README.md: ${s.readmeLines} lines`);
  } else if (hasComprehensiveClaudeMd) {
    score += 10;
    findings.push('README.md not present (CLAUDE.md provides equivalent LLM orientation)');
  } else {
    recommendations.push('Add a README.md or CLAUDE.md with project overview, setup instructions, and architecture notes');
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

  // AI config file bonus: up to 5 pts for quality config files beyond CLAUDE.md
  const aiConfigs = s.aiConfigScores.filter(c => c.exists);
  if (aiConfigs.length > 0) {
    const avgQuality = aiConfigs.reduce((sum, c) => sum + c.contentScore, 0) / aiConfigs.length;
    score += Math.min(Math.round(avgQuality / 20), 5);
    findings.push(`AI config files: ${aiConfigs.map(c => `${c.file} (${c.contentScore}/100)`).join(', ')}`);
  }

  // AI config coverage bonus: 0-8 pts based on how many AI tools have config files
  score += s.aiConfigCoverage;
  if (s.aiConfigCoverage > 0) {
    findings.push(`AI config coverage: ${aiConfigs.length} tool(s) configured (+${s.aiConfigCoverage} pts)`);
  }

  // Config drift penalty: -2 pts per stale reference, capped at -20
  if (s.configDrift.staleReferences.length > 0) {
    const driftPenalty = Math.min(s.configDrift.staleReferences.length * 2, 20);
    score -= driftPenalty;
    findings.push(`Config drift: ${s.configDrift.staleReferences.length} stale reference(s) found (freshness: ${s.configDrift.freshnessScore}%)`);
    recommendations.push(`Fix ${s.configDrift.staleReferences.length} stale config reference(s) — stale configs actively mislead LLMs`);
  } else if (s.configDrift.totalReferences > 0) {
    // 100% fresh configs: +5 bonus
    score += 5;
    findings.push(`Config freshness: 100% (${s.configDrift.totalReferences} references validated)`);
  }

  // AI config consistency penalty: -2 pts per cross-file contradiction
  if (s.aiConfigConsistency < 100) {
    const consistencyPenalty = Math.round((100 - s.aiConfigConsistency) / 2);
    score -= Math.min(consistencyPenalty, 10);
    findings.push(`AI config consistency: ${s.aiConfigConsistency}% — some config files may contradict each other`);
  }

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

export function scoreModularity(s: StaticAnalysisResult['modularity'], doc: StaticAnalysisResult['documentation']): CategoryScore {
  // Measures how well code is organized into cohesive modules.
  // Single-file directories suggest over-splitting; many-file directories suggest under-splitting.
  // EXCEPTION: modular architectures intentionally use single-file dirs for module structure.
  let score = 70; // baseline — most organized projects start here

  if (s.avgFilesPerDirectory >= 3 && s.avgFilesPerDirectory <= 10) score += 15;
  else if (s.avgFilesPerDirectory > 10) score -= Math.min((s.avgFilesPerDirectory - 10) * 2, 20);

  // Check if CLAUDE.md documents a modular architecture (single-file dirs are intentional)
  const claudeMdRaw = doc.claudeMdContent?.rawContent ?? '';
  const hasModularArchitecture = /\b(modular\s+monolith|self-contained\s+module|each\s+module\s+(is|has)|module.based|feature.based\s+(structure|architecture|organization))\b/i.test(claudeMdRaw);
  const hasStrongBarrelPattern = s.barrelExportCount > 20;

  const singleFileDirRatio = s.totalDirectories > 0 ? s.singleFileDirectories / s.totalDirectories : 0;

  if (hasModularArchitecture || hasStrongBarrelPattern) {
    // Modular architecture: don't penalize single-file dirs, give bonus for barrel exports
    if (s.barrelExportCount > 0) score += 10;
  } else {
    if (singleFileDirRatio > 0.4) score -= 10;
    if (singleFileDirRatio < 0.2) score += 10;
    if (s.barrelExportCount > 0) score += 5;
  }

  score = clamp(score);

  const findings = [
    `Avg ${s.avgFilesPerDirectory} files/dir, ${s.singleFileDirectories} single-file dirs`,
    `${s.barrelExportCount} barrel export files (index.ts/js)`,
  ];
  const recommendations: string[] = [];

  if (hasModularArchitecture) {
    findings.push('Modular architecture detected — single-file directories are intentional');
  }

  if (s.maxFilesInDirectory.count > 20) {
    recommendations.push(`\`${s.maxFilesInDirectory.path}\` has ${s.maxFilesInDirectory.count} files — consider splitting into sub-modules`);
  }
  if (!hasModularArchitecture && !hasStrongBarrelPattern && singleFileDirRatio > 0.3) {
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
    `${s.generatedFileCount} generated files, ${s.binaryFileCount} binary files${s.vendoredFileCount > 0 ? `, ${s.vendoredFileCount} vendored files` : ''}`,
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

  // Difficulty-weighted scoring: hard task success counts 2x, easy counts 0.5x
  const totalWeight = taskResults.reduce((sum, r) => sum + DIFFICULTY_WEIGHTS[r.taskDifficulty], 0);

  const weightedSuccess = taskResults.reduce((sum, r) =>
    sum + (r.success ? DIFFICULTY_WEIGHTS[r.taskDifficulty] : 0), 0);
  const weightedSuccessRate = weightedSuccess / totalWeight;

  const weightedCorrectness = taskResults.reduce((sum, r) =>
    sum + r.correctnessScore * DIFFICULTY_WEIGHTS[r.taskDifficulty], 0) / totalWeight;

  // Efficiency bonus rewards codebases where tasks complete in fewer turns.
  const successful = taskResults.filter(r => r.success);
  const avgTurnRatio = successful.length > 0
    ? successful.reduce((sum, r) => sum + r.numTurns, 0) / (successful.length * 30)
    : 1;
  const efficiencyBonus = weightedSuccessRate > 0.5 ? (1 - avgTurnRatio) * 20 : 0;

  const score = clamp(weightedSuccessRate * 60 + weightedCorrectness * 20 + efficiencyBonus);

  // Per-difficulty breakdown for findings
  const byDifficulty = (['easy', 'medium', 'hard'] as const).map(d => {
    const tasks = taskResults.filter(r => r.taskDifficulty === d);
    const passed = tasks.filter(r => r.success).length;
    return tasks.length > 0 ? `${d}: ${passed}/${tasks.length}` : null;
  }).filter(Boolean);

  const successCount = taskResults.filter(r => r.success).length;
  const findings = [
    `${successCount}/${taskResults.length} tasks completed (${byDifficulty.join(', ')})`,
    `Weighted success: ${(weightedSuccessRate * 100).toFixed(0)}% (difficulty weights: easy=0.5x, medium=1x, hard=2x)`,
    `Weighted file correctness: ${(weightedCorrectness * 100).toFixed(0)}%`,
    `Avg turns: ${(taskResults.reduce((s, r) => s + r.numTurns, 0) / taskResults.length).toFixed(1)}`,
  ];
  const recommendations: string[] = [];

  const failed = taskResults.filter(r => !r.success);
  if (failed.length > 0) {
    recommendations.push(`${failed.length} tasks failed — review codebase structure in affected areas`);
    // Prioritize hard failures in recommendations
    const sortedFailed = [...failed].sort((a, b) => DIFFICULTY_WEIGHTS[b.taskDifficulty] - DIFFICULTY_WEIGHTS[a.taskDifficulty]);
    for (const f of sortedFailed.slice(0, 3)) {
      recommendations.push(`Task "${f.taskTitle}" (${f.taskDifficulty}) failed: ${f.errors[0] || f.stopReason}`);
    }
  }

  if (weightedCorrectness < 0.5) {
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

export function scoreCoupling(
  s: StaticAnalysisResult['imports'],
  fragmentationRatio: number,
  duplicates: StaticAnalysisResult['duplicates'],
): CategoryScore {
  // Measures how tightly coupled the codebase is based on the dependency graph.
  // Low coupling = easier for LLMs to work on isolated parts.
  let score = 70; // baseline

  // Fan-out: avg imports per file. 3-8 is healthy; >15 suggests files do too much
  if (s.avgFanOut <= 8) score += 10;
  else if (s.avgFanOut > 15) score -= Math.min((s.avgFanOut - 15) * 2, 20);

  // Hub files: files with fan-in > 10 are risky — changes ripple widely
  if (s.hubFiles.length === 0) score += 10;
  else score -= Math.min(s.hubFiles.length * 3, 15);

  // Max chain depth: deep chains (>8) mean LLMs must trace many files
  if (s.maxChainDepth <= 5) score += 10;
  else if (s.maxChainDepth > 8) score -= Math.min((s.maxChainDepth - 8) * 3, 15);

  // Context fragmentation: inter-cluster vs intra-cluster import ratio
  if (fragmentationRatio < 0.3) score += 10;
  else if (fragmentationRatio > 0.6) score -= 10;

  // Semantic duplicates penalty: each pair confuses LLMs about which version to use
  if (duplicates.pairs.length > 0) {
    score -= Math.min(duplicates.pairs.length * 3, 15);
  }

  score = clamp(score);

  const findings: string[] = [
    `Avg fan-out: ${s.avgFanOut} imports/file, avg fan-in: ${s.avgFanIn}`,
    `Max dependency chain depth: ${s.maxChainDepth}`,
    `Context fragmentation: ${(fragmentationRatio * 100).toFixed(0)}% cross-cluster imports`,
  ];
  const recommendations: string[] = [];

  if (s.hubFiles.length > 0) {
    findings.push(`Hub files (fan-in >10): ${s.hubFiles.map(h => h.path).slice(0, 3).join(', ')}`);
    recommendations.push('Consider breaking hub files into smaller modules to reduce coupling');
  }
  if (s.orphanFiles.length > 5) {
    findings.push(`${s.orphanFiles.length} orphan files (no local imports or importers)`);
  }
  if (fragmentationRatio > 0.5) {
    recommendations.push('High context fragmentation — related logic is scattered across many clusters. Consider grouping related files into cohesive modules');
  }
  if (duplicates.pairs.length > 0) {
    findings.push(`${duplicates.pairs.length} potential duplicate pair(s) detected`);
    for (const p of duplicates.pairs.slice(0, 3)) {
      recommendations.push(`Consolidate \`${p.fileA}\` and \`${p.fileB}\` (${Math.round(p.similarity * 100)}% export overlap)`);
    }
  }

  return { name: 'Coupling', score, weight: 0, findings, recommendations };
}

export function scoreDevInfra(s: StaticAnalysisResult['devInfra']): CategoryScore {
  // Total possible score from analyzer: 17 (1+4+3+2+3+1+1+2), scaled to 0-100
  // Heavily weighted toward LLM-relevant infra (tests=4, linter=3, types=3, hooks=2, observability=2)
  // Bonus points for project hygiene (CI=1, devcontainer=1, task discovery=1)
  const score = clamp(Math.round(s.score * (100 / 17)));

  const findings: string[] = [];
  const recommendations: string[] = [];

  // Core LLM-relevant infra (high priority)
  if (s.hasTestCommand) findings.push('Test command configured');
  else recommendations.push('Add a test command — LLMs use tests as a feedback loop to verify changes');

  if (s.hasLinterConfig) findings.push('Linter configured');
  else recommendations.push('Add a linter configuration — LLMs use lint output to self-correct');

  if (s.hasTypeChecking) findings.push('Type checking configured');
  else recommendations.push('Add type checking — type errors are critical feedback for LLM-generated code');

  if (s.hasPreCommitHooks) findings.push('Pre-commit hooks configured');

  // Bonus infra (lower priority — doesn't directly help LLMs)
  if (s.hasCi) findings.push(`CI: ${s.ciFiles.join(', ')}`);
  if (s.hasDevcontainer) findings.push(`Devcontainer: ${s.devcontainerFeatures.join(', ')}`);
  if (s.hasIssueTemplates) findings.push('Issue templates configured');
  if (s.hasPrTemplate) findings.push('PR template configured');
  if (s.hasContributing) findings.push('CONTRIBUTING.md present');
  if (s.hasChangelog) findings.push('Changelog present');
  if (s.todoCount > 0) {
    findings.push(`~${s.todoCount} TODO/FIXME/HACK comments found`);
  }

  // Observability
  if (s.hasStructuredLogging) findings.push('Structured logging detected');
  else recommendations.push('Add a structured logging library (pino, winston, zerolog) for better debugging');

  if (s.hasEnvExample) findings.push('.env.example present');
  else recommendations.push('Add .env.example to document required environment variables');

  if (s.hasHealthCheck) findings.push('Health check endpoint detected');
  if (s.hasOpenTelemetry) findings.push('OpenTelemetry configured');

  return { name: 'Developer Infrastructure', score, weight: 0, findings, recommendations };
}

export function scoreSecurity(s: StaticAnalysisResult['security']): CategoryScore {
  const score = s.score;

  const findings: string[] = [];
  const recommendations: string[] = [];

  if (s.findings.length === 0) {
    findings.push('No security issues detected');
  } else {
    for (const f of s.findings) {
      findings.push(`${f.check}: ${f.detail}`);
    }
  }

  if (!s.hasGitignore) recommendations.push('Add a .gitignore file to prevent accidental secret exposure');
  if (s.envExposed) recommendations.push('Add .env to .gitignore to protect secrets');
  if (s.hardcodedSecretFiles.length > 0) recommendations.push('Move hardcoded secrets to environment variables');
  if (s.sensitiveFilesTracked.length > 0) recommendations.push('Remove sensitive files (*.pem, *.key, credentials.*) from the repository');
  if (s.missingLockfile) recommendations.push('Add a dependency lockfile for reproducible builds');

  return { name: 'Security', score, weight: 0, findings, recommendations };
}

export function scoreCodeQuality(
  languageChecks?: LanguageCheckResult[],
  astAnalysis?: AstAnalysisResult,
  llmLint?: FinalReport['llmLint'],
): CategoryScore {
  if ((!languageChecks || languageChecks.length === 0) && !astAnalysis && !llmLint) {
    return { name: 'Code Quality', score: 100, weight: 0, findings: ['No language-specific checks applicable'], recommendations: [] };
  }

  // Start at 100, subtract total penalties across all languages
  let totalPenalty = 0;
  const findings: string[] = [];
  const recommendations: string[] = [];

  // Regex-based penalties
  if (languageChecks) {
    for (const lc of languageChecks) {
      if (lc.totalPenalty > 0) {
        totalPenalty += lc.totalPenalty;
        findings.push(`${lc.language}: -${lc.totalPenalty} pts across ${lc.checks.filter(c => c.occurrences > 0).length} check(s)`);
      }

      for (const check of lc.checks) {
        if (check.occurrences > 0 && check.penalty > 0) {
          const applied = Math.min(check.occurrences * check.penalty, check.cap);
          recommendations.push(`Fix ${check.occurrences} ${check.name} issue(s) in ${lc.language} files (-${applied} pts)`);
        } else if (check.occurrences > 0) {
          findings.push(`${lc.language}: ${check.occurrences} ${check.name} finding(s) (informational)`);
        }
      }
    }
  }

  // AST-based penalties (tree-sitter)
  if (astAnalysis) {
    findings.push(`AST: ${astAnalysis.totalFunctionsAnalyzed} functions in ${astAnalysis.totalFilesAnalyzed} files analyzed`);
    findings.push(`Avg complexity: ${astAnalysis.avgComplexity.toFixed(1)}, avg nesting: ${astAnalysis.avgNestingDepth.toFixed(1)}, avg length: ${astAnalysis.avgFunctionLength.toFixed(0)} lines`);

    // High average complexity penalty: -2 per point above 5
    if (astAnalysis.avgComplexity > 5) {
      const penalty = Math.min(Math.round((astAnalysis.avgComplexity - 5) * 2), 15);
      totalPenalty += penalty;
      recommendations.push(`Reduce average cyclomatic complexity from ${astAnalysis.avgComplexity.toFixed(1)} to ≤5 (-${penalty} pts)`);
    }

    // High max complexity penalty
    if (astAnalysis.maxComplexity && astAnalysis.maxComplexity.cyclomaticComplexity > 15) {
      totalPenalty += 5;
      recommendations.push(`Refactor \`${astAnalysis.maxComplexity.name}\` in ${astAnalysis.maxComplexity.file} (complexity: ${astAnalysis.maxComplexity.cyclomaticComplexity})`);
    }

    // Deep nesting penalty
    if (astAnalysis.avgNestingDepth > 3) {
      const penalty = Math.min(Math.round((astAnalysis.avgNestingDepth - 3) * 3), 10);
      totalPenalty += penalty;
      recommendations.push(`Reduce average nesting depth from ${astAnalysis.avgNestingDepth.toFixed(1)} to ≤3 (-${penalty} pts)`);
    }

    // Long functions penalty
    if (astAnalysis.avgFunctionLength > 40) {
      const penalty = Math.min(Math.round((astAnalysis.avgFunctionLength - 40) / 5), 10);
      totalPenalty += penalty;
      recommendations.push(`Average function length is ${astAnalysis.avgFunctionLength.toFixed(0)} lines — aim for ≤30`);
    }

    // Empty catch blocks
    if (astAnalysis.emptyCatchBlocks > 0) {
      const penalty = Math.min(astAnalysis.emptyCatchBlocks * 2, 10);
      totalPenalty += penalty;
      findings.push(`${astAnalysis.emptyCatchBlocks} empty catch block(s)`);
      recommendations.push(`Fix ${astAnalysis.emptyCatchBlocks} empty catch block(s) — they silently swallow errors`);
    }

    // Type annotation coverage
    if (astAnalysis.typeAnnotationCoverage < 0.5) {
      findings.push(`Type annotation coverage: ${(astAnalysis.typeAnnotationCoverage * 100).toFixed(0)}%`);
    }

    // Structural duplicates
    if (astAnalysis.structuralDuplicates.length > 0) {
      findings.push(`${astAnalysis.structuralDuplicates.length} structural duplicate(s) detected`);
      const penalty = Math.min(astAnalysis.structuralDuplicates.length * 2, 10);
      totalPenalty += penalty;
      for (const dup of astAnalysis.structuralDuplicates.slice(0, 3)) {
        recommendations.push(`Consolidate \`${dup.functionA.name}\` (${dup.functionA.file}:${dup.functionA.line}) and \`${dup.functionB.name}\` (${dup.functionB.file}:${dup.functionB.line}) — structurally identical`);
      }
    }

    // Call graph insights
    if (astAnalysis.callGraph) {
      const cg = astAnalysis.callGraph;
      if (cg.hotFunctions.length > 0) {
        findings.push(`Hot functions: ${cg.hotFunctions.slice(0, 3).map(f => `${f.name} (${f.callCount} calls)`).join(', ')}`);
      }
      if (cg.isolatedFunctions.length > 5) {
        findings.push(`${cg.isolatedFunctions.length} potentially unused function(s)`);
      }
    }

    // API surface
    if (astAnalysis.apiSurface) {
      const api = astAnalysis.apiSurface;
      if (api.exportedFunctions > 0) {
        findings.push(`API surface: ${api.exportedFunctions} exported functions, avg complexity ${api.avgExportComplexity.toFixed(1)}`);
      }
      if (api.complexExports.length > 0) {
        recommendations.push(`Simplify complex exports: ${api.complexExports.slice(0, 2).map(e => `${e.name} (cc=${e.complexity})`).join(', ')}`);
      }
    }
  }

  // LLM lint findings (Phase 2c)
  if (llmLint && llmLint.findings.length > 0) {
    const errors = llmLint.findings.filter(f => f.severity === 'error').length;
    const warnings = llmLint.findings.filter(f => f.severity === 'warning').length;
    // Errors: -3 pts each (cap 15), warnings: -2 pts each (cap 10)
    const errorPenalty = Math.min(errors * 3, 15);
    const warningPenalty = Math.min(warnings * 2, 10);
    totalPenalty += errorPenalty + warningPenalty;
    findings.push(`LLM lint: ${llmLint.findings.length} finding(s) (${errors} errors, ${warnings} warnings)`);
    // Add top 3 findings as recommendations
    for (const f of llmLint.findings.slice(0, 3)) {
      recommendations.push(`[LLM lint] ${f.ruleName}: \`${f.functionName}\` in ${f.file}:${f.startLine} — ${f.suggestedFix}`);
    }
  }

  if (totalPenalty === 0 && !astAnalysis && !llmLint) {
    findings.push('No language-specific anti-patterns detected');
  }

  const score = clamp(100 - totalPenalty);
  return { name: 'Code Quality', score, weight: 0, findings, recommendations };
}

// Load a custom scoring profile from .llm-sense/profile.json
export async function loadProfile(targetPath: string, profileName: string): Promise<Record<string, number> | null> {
  // Check built-in profiles first
  if (SCORING_PROFILES[profileName]) {
    return SCORING_PROFILES[profileName];
  }

  // Try loading from file
  try {
    const profilePath = join(targetPath, '.llm-sense', 'profile.json');
    const content = await readFile(profilePath, 'utf-8');
    const profile = JSON.parse(content);
    if (profile.weights && typeof profile.weights === 'object') {
      const sum = Object.values(profile.weights as Record<string, number>).reduce((a: number, b: number) => a + b, 0);
      if (Math.abs(sum - 1.0) > 0.01) {
        console.error(`Warning: Profile weights sum to ${sum.toFixed(2)}, expected 1.0`);
      }
      return profile.weights;
    }
  } catch {}
  return null;
}

export function computeScores(
  staticResult: StaticAnalysisResult,
  taskResults: TaskExecutionResult[],
  skipEmpirical: boolean,
  profileWeights?: Record<string, number>,
  llmLint?: FinalReport['llmLint'],
): { categories: CategoryScore[]; overallScore: number; grade: string } {
  const weights = profileWeights ?? (skipEmpirical ? SCORING_WEIGHTS_NO_EMPIRICAL : SCORING_WEIGHTS);

  const categories: CategoryScore[] = [
    { ...scoreDocumentation(staticResult.documentation), weight: weights.documentation ?? 0 },
    { ...scoreFileSizes(staticResult.fileSizes), weight: weights.fileSizes ?? 0 },
    { ...scoreStructure(staticResult.directoryStructure, staticResult.fileSizes.totalFiles), weight: weights.structure ?? 0 },
    { ...scoreModularity(staticResult.modularity, staticResult.documentation), weight: weights.modularity ?? 0 },
    { ...scoreContextEfficiency(staticResult.noise), weight: weights.contextEfficiency ?? 0 },
    { ...scoreNaming(staticResult.naming), weight: weights.naming ?? 0 },
    { ...scoreCoupling(staticResult.imports, staticResult.fragmentationRatio, staticResult.duplicates), weight: weights.coupling ?? 0 },
    { ...scoreDevInfra(staticResult.devInfra), weight: weights.devInfra ?? 0 },
    { ...scoreSecurity(staticResult.security), weight: weights.security ?? 0 },
    { ...scoreCodeQuality(staticResult.languageChecks, staticResult.astAnalysis, llmLint), weight: weights.codeQuality ?? 0 },
  ];

  if (!skipEmpirical) {
    categories.push(
      { ...scoreTaskCompletion(taskResults), weight: weights.taskCompletion ?? 0 },
      { ...scoreTokenEfficiency(taskResults, staticResult.fileSizes.totalFiles), weight: weights.tokenEfficiency ?? 0 },
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
