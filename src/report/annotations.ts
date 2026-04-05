import type { StaticAnalysisResult } from '../types.js';

export interface Annotation {
  file: string;
  line?: number;
  severity: 'error' | 'warning' | 'info';
  category: string;
  message: string;
}

/**
 * Extract file-level annotations from static analysis results.
 * Used by the GitHub Action for inline PR review comments.
 * Capped at maxAnnotations to avoid noise.
 */
export function buildAnnotations(
  staticResult: StaticAnalysisResult,
  maxAnnotations: number = 20,
): Annotation[] {
  const annotations: Annotation[] = [];

  // 1. God files (>1000 lines code files)
  for (const f of staticResult.fileSizes.largestFiles) {
    if (f.lines >= 1000 && f.classification === 'code') {
      annotations.push({
        file: f.path,
        severity: f.lines >= 2000 ? 'error' : 'warning',
        category: 'File Sizes',
        message: `This file has ${f.lines.toLocaleString()} lines — consider splitting into smaller, focused modules`,
      });
    }
  }

  // 2. Security findings (hardcoded secrets, exposed .env)
  for (const finding of staticResult.security.findings) {
    if (finding.severity === 'high') {
      annotations.push({
        file: finding.detail.match(/`([^`]+)`/)?.[1] ?? '',
        severity: 'error',
        category: 'Security',
        message: `${finding.check}: ${finding.detail}`,
      });
    }
  }
  for (const secretFile of staticResult.security.hardcodedSecretFiles) {
    annotations.push({
      file: secretFile,
      severity: 'error',
      category: 'Security',
      message: 'Potential hardcoded secret detected — move to environment variables',
    });
  }

  // 3. Hub files (high fan-in — many files depend on them)
  for (const hub of staticResult.imports.hubFiles) {
    annotations.push({
      file: hub.path,
      severity: 'warning',
      category: 'Coupling',
      message: `Hub file with fan-in of ${hub.fanIn} — ${hub.fanIn} other files import this. Changes here have wide blast radius.`,
    });
  }

  // 4. AST complexity hotspots
  if (staticResult.astAnalysis?.functions) {
    const highComplexity = staticResult.astAnalysis.functions
      .filter(f => f.cyclomaticComplexity >= 15)
      .sort((a, b) => b.cyclomaticComplexity - a.cyclomaticComplexity)
      .slice(0, 10);

    for (const fn of highComplexity) {
      annotations.push({
        file: fn.file,
        line: fn.startLine,
        severity: fn.cyclomaticComplexity >= 25 ? 'error' : 'warning',
        category: 'Code Quality',
        message: `Function \`${fn.name}\` has cyclomatic complexity ${fn.cyclomaticComplexity} (${fn.lineCount} lines) — consider breaking into smaller functions`,
      });
    }
  }

  // 5. AST deep nesting
  if (staticResult.astAnalysis?.functions) {
    const deepNesting = staticResult.astAnalysis.functions
      .filter(f => f.maxNestingDepth >= 5)
      .sort((a, b) => b.maxNestingDepth - a.maxNestingDepth)
      .slice(0, 5);

    for (const fn of deepNesting) {
      annotations.push({
        file: fn.file,
        line: fn.startLine,
        severity: 'warning',
        category: 'Code Quality',
        message: `Function \`${fn.name}\` has nesting depth ${fn.maxNestingDepth} — extract inner logic to separate functions`,
      });
    }
  }

  // 6. Naming inconsistencies
  if (staticResult.naming.inconsistencies.length > 0) {
    for (const inconsistency of staticResult.naming.inconsistencies.slice(0, 5)) {
      // Inconsistency format is like "fileName uses camelCase, but directory uses snake_case"
      const fileMatch = inconsistency.match(/^(\S+)/);
      if (fileMatch) {
        annotations.push({
          file: fileMatch[1],
          severity: 'info',
          category: 'Naming',
          message: inconsistency,
        });
      }
    }
  }

  // 7. Config drift (stale references)
  for (const ref of staticResult.documentation.configDrift.staleReferences.slice(0, 5)) {
    annotations.push({
      file: ref.file,
      line: ref.line,
      severity: 'warning',
      category: 'Documentation',
      message: `Stale reference: \`${ref.reference}\` — ${ref.reason}`,
    });
  }

  // 8. Structural duplicates
  if (staticResult.astAnalysis?.structuralDuplicates) {
    for (const dup of staticResult.astAnalysis.structuralDuplicates.slice(0, 5)) {
      annotations.push({
        file: dup.functionA.file,
        line: dup.functionA.line,
        severity: 'info',
        category: 'Code Quality',
        message: `Structural duplicate of \`${dup.functionB.name}\` in ${dup.functionB.file}:${dup.functionB.line} (${dup.lineCount} lines)`,
      });
    }
  }

  // Sort by severity (error > warning > info), then cap
  const severityOrder = { error: 0, warning: 1, info: 2 };
  return annotations
    .filter(a => a.file) // remove annotations without a file
    .sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity])
    .slice(0, maxAnnotations);
}
