import { readFile, readdir, access } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { z } from 'zod';
import { callClaudeStructured, callClaudeWithRetry } from '../core/claude.js';
import { stratifiedSample, getSourceFiles, readFileSafe, type WalkEntry } from '../core/fs.js';
import {
  isAstAvailable, parseFileAST, getLanguageForExt, getNodeTypes, walkTree,
  type TreeSitterNode,
} from '../core/ast.js';
import type { AstAnalysisResult, FunctionMetrics } from '../types.js';

// ─── Rule Definition ─────────────────────────────────────

export interface LintRule {
  id: string;
  name: string;
  description: string;
  severity: 'error' | 'warning' | 'info';
  category: 'single-responsibility' | 'naming' | 'dead-code' | 'error-handling' | 'edge-cases';
  // Pre-filter criteria: only pass candidates matching these to the LLM
  preFilter: {
    minComplexity?: number;     // Only functions with CC >= this
    minLines?: number;          // Only functions with >= this many lines
    minNesting?: number;        // Only functions with nesting >= this
    hasPattern?: RegExp;        // Only files containing this pattern
    minParams?: number;         // Only functions with >= this many params
  };
  // Prompt segment to send to the LLM for evaluation
  evalPrompt: string;
}

// ─── Built-in Rules ──────────────────────────────────────

const BUILTIN_RULES: LintRule[] = [
  {
    id: 'single-responsibility',
    name: 'Functions should do one thing',
    description: 'Detects functions that handle multiple unrelated responsibilities',
    severity: 'warning',
    category: 'single-responsibility',
    preFilter: { minComplexity: 8, minLines: 25 },
    evalPrompt: `Does this function violate the Single Responsibility Principle? Look for:
- Multiple distinct operations that could be split into separate functions
- Mixed levels of abstraction (e.g., business logic mixed with I/O)
- Functions that do "A and then B" where A and B are unrelated
If yes, explain what responsibilities should be split. If no, say "PASS".`,
  },
  {
    id: 'misleading-names',
    name: 'Misleading function/variable names',
    description: 'Detects names that do not match the actual behavior of the code',
    severity: 'warning',
    category: 'naming',
    preFilter: { minLines: 10 },
    evalPrompt: `Does this function have a misleading name? Check if:
- The function name implies one thing but the code does something different or additional
- Variable names inside suggest a different purpose than the function name
- The return type/value doesn't match what the name suggests
If misleading, explain the mismatch. If the name is accurate, say "PASS".`,
  },
  {
    id: 'dead-code',
    name: 'Dead code paths',
    description: 'Detects unreachable code that static analysis alone cannot catch',
    severity: 'info',
    category: 'dead-code',
    preFilter: { minComplexity: 5, minLines: 15 },
    evalPrompt: `Does this function contain dead code paths? Look for:
- Conditions that can never be true/false given the surrounding logic
- Early returns that make subsequent code unreachable
- Variables that are assigned but never used in any meaningful way
- Branches that duplicate other branches' behavior
If found, identify the dead code. If none, say "PASS".`,
  },
  {
    id: 'inconsistent-error-handling',
    name: 'Inconsistent error handling patterns',
    description: 'Detects mixed error handling paradigms within the same function or module',
    severity: 'warning',
    category: 'error-handling',
    preFilter: { minLines: 15, hasPattern: /catch|\.catch|throw|reject|Result|Err|error/i },
    evalPrompt: `Does this code use inconsistent error handling? Check for:
- Mixing try/catch with .catch() promises in the same scope
- Some errors thrown, others silently swallowed (empty catch blocks)
- Inconsistent error types (sometimes Error, sometimes strings, sometimes custom types)
- Missing error handling for operations that can fail
If inconsistent, describe the mix. If consistent, say "PASS".`,
  },
  {
    id: 'missing-edge-cases',
    name: 'Missing edge case handling',
    description: 'Identifies likely unhandled edge cases that could cause bugs',
    severity: 'info',
    category: 'edge-cases',
    preFilter: { minComplexity: 4, minLines: 10 },
    evalPrompt: `Does this function have likely unhandled edge cases? Consider:
- Null/undefined inputs not checked
- Empty arrays/strings not handled
- Numeric edge cases (zero, negative, overflow)
- Race conditions in async code
- Off-by-one errors in loops/slicing
Only flag HIGH CONFIDENCE edge cases that would likely cause bugs. If the code handles edges well, say "PASS".`,
  },
];

// ─── LLM Lint Finding ───────────────────────────────────

export interface LlmLintFinding {
  ruleId: string;
  ruleName: string;
  severity: 'error' | 'warning' | 'info';
  category: string;
  file: string;
  functionName: string;
  startLine: number;
  endLine: number;
  explanation: string;
  suggestedFix: string;
}

export interface LlmLintResult {
  findings: LlmLintFinding[];
  rulesEvaluated: number;
  candidatesEvaluated: number;
  filesScanned: number;
  totalCostUsd: number;
  durationMs: number;
}

// ─── Zod schema for LLM response ────────────────────────

const LintEvaluationSchema = z.object({
  findings: z.array(z.object({
    functionName: z.string(),
    verdict: z.enum(['PASS', 'FAIL']),
    explanation: z.string(),
    suggestedFix: z.string(),
  })),
});

type LintEvaluation = z.infer<typeof LintEvaluationSchema>;

// ─── Rule Loading ────────────────────────────────────────

async function loadCustomRules(targetPath: string): Promise<LintRule[]> {
  const rulesDir = join(targetPath, '.llm-sense', 'rules');
  try {
    await access(rulesDir);
  } catch {
    return [];
  }

  const rules: LintRule[] = [];
  try {
    const files = await readdir(rulesDir);
    for (const file of files) {
      if (!file.endsWith('.md')) continue;
      try {
        const content = await readFile(join(rulesDir, file), 'utf-8');
        const rule = parseRuleMarkdown(content, file);
        if (rule) rules.push(rule);
      } catch { /* skip malformed rules */ }
    }
  } catch { /* rules dir unreadable */ }

  return rules;
}

function parseRuleMarkdown(content: string, filename: string): LintRule | null {
  // Parse Markdown rule format:
  // # Rule Name
  // severity: warning
  // category: naming
  // min-complexity: 5
  // min-lines: 10
  //
  // ## Description
  // ...
  //
  // ## Evaluation Prompt
  // ...

  const lines = content.split('\n');
  const nameMatch = lines[0]?.match(/^#\s+(.+)/);
  if (!nameMatch) return null;

  const name = nameMatch[1].trim();
  const id = filename.replace('.md', '').replace(/\s+/g, '-').toLowerCase();

  let severity: 'error' | 'warning' | 'info' = 'warning';
  let category: LintRule['category'] = 'single-responsibility';
  const preFilter: LintRule['preFilter'] = {};
  let description = '';
  let evalPrompt = '';

  let section = 'meta';
  for (const line of lines.slice(1)) {
    if (line.startsWith('## Description')) { section = 'description'; continue; }
    if (line.startsWith('## Evaluation Prompt') || line.startsWith('## Eval')) { section = 'eval'; continue; }

    if (section === 'meta') {
      const kv = line.match(/^(\w[\w-]*):\s*(.+)/);
      if (kv) {
        const [, key, value] = kv;
        switch (key.toLowerCase()) {
          case 'severity': severity = value.trim() as 'error' | 'warning' | 'info'; break;
          case 'category': category = value.trim() as LintRule['category']; break;
          case 'min-complexity': preFilter.minComplexity = parseInt(value, 10); break;
          case 'min-lines': preFilter.minLines = parseInt(value, 10); break;
          case 'min-nesting': preFilter.minNesting = parseInt(value, 10); break;
          case 'min-params': preFilter.minParams = parseInt(value, 10); break;
          case 'pattern': preFilter.hasPattern = new RegExp(value.trim(), 'i'); break;
        }
      }
    } else if (section === 'description') {
      description += line + '\n';
    } else if (section === 'eval') {
      evalPrompt += line + '\n';
    }
  }

  if (!evalPrompt.trim()) return null;

  return { id, name, description: description.trim(), severity, category, preFilter, evalPrompt: evalPrompt.trim() };
}

// ─── Pre-Filter (AST Pass 1) ────────────────────────────

interface LintCandidate {
  file: string;
  relativePath: string;
  functionName: string;
  startLine: number;
  endLine: number;
  lineCount: number;
  complexity: number;
  nestingDepth: number;
  parameterCount: number;
  code: string;
  matchedRules: LintRule[];
}

function matchesPreFilter(fn: FunctionMetrics, rule: LintRule, fileContent: string): boolean {
  const pf = rule.preFilter;
  if (pf.minComplexity && fn.cyclomaticComplexity < pf.minComplexity) return false;
  if (pf.minLines && fn.lineCount < pf.minLines) return false;
  if (pf.minNesting && fn.maxNestingDepth < pf.minNesting) return false;
  if (pf.minParams && fn.parameterCount < pf.minParams) return false;
  if (pf.hasPattern && !pf.hasPattern.test(fileContent)) return false;
  return true;
}

async function buildCandidates(
  entries: WalkEntry[],
  astResult: AstAnalysisResult | undefined,
  rules: LintRule[],
  maxCandidates: number,
  verbose: boolean,
): Promise<LintCandidate[]> {
  const candidates: LintCandidate[] = [];

  // If we have AST function metrics, use them for pre-filtering
  if (astResult && astResult.functions.length > 0) {
    // Group functions by file for efficient content reading
    const byFile = new Map<string, FunctionMetrics[]>();
    for (const fn of astResult.functions) {
      if (!byFile.has(fn.file)) byFile.set(fn.file, []);
      byFile.get(fn.file)!.push(fn);
    }

    for (const [file, funcs] of byFile) {
      let content: string;
      try {
        content = await readFile(file, 'utf-8');
      } catch { continue; }

      const lines = content.split('\n');

      for (const fn of funcs) {
        const matchedRules = rules.filter(r => matchesPreFilter(fn, r, content));
        if (matchedRules.length === 0) continue;

        const codeLines = lines.slice(fn.startLine - 1, fn.endLine);
        // Cap code to ~150 lines to stay within token budget
        const code = codeLines.slice(0, 150).join('\n');

        candidates.push({
          file,
          relativePath: fn.file,
          functionName: fn.name,
          startLine: fn.startLine,
          endLine: fn.endLine,
          lineCount: fn.lineCount,
          complexity: fn.cyclomaticComplexity,
          nestingDepth: fn.maxNestingDepth,
          parameterCount: fn.parameterCount,
          code,
          matchedRules,
        });

        if (candidates.length >= maxCandidates) break;
      }
      if (candidates.length >= maxCandidates) break;
    }
  }

  // Fallback: no AST data — sample source files and extract functions heuristically
  if (candidates.length === 0) {
    const sourceFiles = getSourceFiles(entries);
    const sampled = stratifiedSample(sourceFiles, 20);

    for (const file of sampled) {
      let content: string;
      try {
        content = await readFile(file.path, 'utf-8');
      } catch { continue; }

      // Simple heuristic: look for function-like blocks
      const fnRegex = /^(?:export\s+)?(?:async\s+)?(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(|(?:public|private|protected)\s+(?:async\s+)?(\w+)\s*\()/gm;
      let match: RegExpExecArray | null;
      const lines = content.split('\n');

      while ((match = fnRegex.exec(content)) !== null) {
        const name = match[1] || match[2] || match[3] || '<anonymous>';
        const lineNum = content.slice(0, match.index).split('\n').length;

        // Rough heuristic for function end: next function or +100 lines
        const endLine = Math.min(lineNum + 100, lines.length);
        const code = lines.slice(lineNum - 1, endLine).join('\n');
        const lineCount = endLine - lineNum + 1;

        // Check against all rules (without complexity info, use lenient matching)
        const matchedRules = rules.filter(r => {
          if (r.preFilter.minLines && lineCount < r.preFilter.minLines) return false;
          if (r.preFilter.hasPattern && !r.preFilter.hasPattern.test(code)) return false;
          return true;
        });

        if (matchedRules.length > 0) {
          candidates.push({
            file: file.path,
            relativePath: file.relativePath,
            functionName: name,
            startLine: lineNum,
            endLine,
            lineCount,
            complexity: 0,
            nestingDepth: 0,
            parameterCount: 0,
            code: code.slice(0, 4000),
            matchedRules,
          });
        }

        if (candidates.length >= maxCandidates) break;
      }
      if (candidates.length >= maxCandidates) break;
    }
  }

  // Sort by number of matched rules × complexity (highest risk first)
  candidates.sort((a, b) => {
    const scoreA = a.matchedRules.length * (a.complexity || 1);
    const scoreB = b.matchedRules.length * (b.complexity || 1);
    return scoreB - scoreA;
  });

  return candidates.slice(0, maxCandidates);
}

// ─── LLM Evaluation (Pass 2) ────────────────────────────

async function evaluateBatch(
  candidates: LintCandidate[],
  rule: LintRule,
  cwd: string,
  model?: string,
): Promise<{ findings: LlmLintFinding[]; costUsd: number }> {
  // Group candidates into batches of 5 to reduce LLM calls
  const batchSize = 5;
  const findings: LlmLintFinding[] = [];
  let totalCost = 0;

  for (let i = 0; i < candidates.length; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize);

    const functionsBlock = batch.map((c, idx) => `### Function ${idx + 1}: \`${c.functionName}\` (${c.relativePath}:${c.startLine})
\`\`\`
${c.code.slice(0, 3000)}
\`\`\``).join('\n\n');

    const prompt = `You are a code quality reviewer. Evaluate ${batch.length} function(s) against this rule:

**Rule: ${rule.name}**
${rule.evalPrompt}

${functionsBlock}

For each function, determine if it PASSES or FAILS this rule. If it fails, explain why and suggest a fix. Be concise — 1-2 sentences for explanation, 1 sentence for fix.`;

    try {
      const { data, result } = await callClaudeWithRetry(
        () => callClaudeStructured(
          { prompt, cwd, timeout: 60_000, model, tools: '', bare: false },
          LintEvaluationSchema,
        ),
      );
      totalCost += result.costUsd;

      for (const finding of data.findings) {
        if (finding.verdict === 'PASS') continue;

        // Match finding back to candidate
        const candidate = batch.find(c => c.functionName === finding.functionName)
          ?? batch[data.findings.indexOf(finding)] // fallback to position
          ?? batch[0];

        if (candidate) {
          findings.push({
            ruleId: rule.id,
            ruleName: rule.name,
            severity: rule.severity,
            category: rule.category,
            file: candidate.relativePath,
            functionName: candidate.functionName,
            startLine: candidate.startLine,
            endLine: candidate.endLine,
            explanation: finding.explanation,
            suggestedFix: finding.suggestedFix,
          });
        }
      }
    } catch {
      // LLM call failed for this batch — continue with next
    }
  }

  return { findings, costUsd: totalCost };
}

// ─── Main Entry Point ────────────────────────────────────

export async function runLlmLint(
  targetPath: string,
  entries: WalkEntry[],
  astResult: AstAnalysisResult | undefined,
  verbose: boolean,
  model?: string,
): Promise<LlmLintResult> {
  const startTime = Date.now();
  let totalCost = 0;

  // Load rules: built-in + custom
  const customRules = await loadCustomRules(targetPath);
  const allRules = [...BUILTIN_RULES, ...customRules];

  if (verbose) {
    console.error(`  ${allRules.length} lint rules loaded (${BUILTIN_RULES.length} built-in, ${customRules.length} custom)`);
  }

  // Pass 1: AST pre-filter — build candidates
  // Cap at 30 candidates to control LLM cost (~6 LLM calls × 5 candidates each)
  const maxCandidates = 30;
  const candidates = await buildCandidates(entries, astResult, allRules, maxCandidates, verbose);

  if (verbose) {
    console.error(`  ${candidates.length} candidate functions matched pre-filters`);
  }

  if (candidates.length === 0) {
    return {
      findings: [],
      rulesEvaluated: allRules.length,
      candidatesEvaluated: 0,
      filesScanned: new Set(entries.map(e => e.path)).size,
      totalCostUsd: 0,
      durationMs: Date.now() - startTime,
    };
  }

  // Pass 2: LLM evaluation — evaluate each rule against its matching candidates
  const allFindings: LlmLintFinding[] = [];

  for (const rule of allRules) {
    const ruleCandidates = candidates.filter(c => c.matchedRules.some(r => r.id === rule.id));
    if (ruleCandidates.length === 0) continue;

    if (verbose) {
      console.error(`  Evaluating rule "${rule.name}" against ${ruleCandidates.length} candidates...`);
    }

    const { findings, costUsd } = await evaluateBatch(ruleCandidates, rule, targetPath, model);
    allFindings.push(...findings);
    totalCost += costUsd;
  }

  // Deduplicate findings (same function + same rule)
  const seen = new Set<string>();
  const deduped = allFindings.filter(f => {
    const key = `${f.file}:${f.startLine}:${f.ruleId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Sort by severity (error > warning > info), then by file
  const severityOrder = { error: 0, warning: 1, info: 2 };
  deduped.sort((a, b) => {
    const sevDiff = severityOrder[a.severity] - severityOrder[b.severity];
    if (sevDiff !== 0) return sevDiff;
    return a.file.localeCompare(b.file);
  });

  return {
    findings: deduped,
    rulesEvaluated: allRules.length,
    candidatesEvaluated: candidates.length,
    filesScanned: new Set(candidates.map(c => c.file)).size,
    totalCostUsd: totalCost,
    durationMs: Date.now() - startTime,
  };
}
