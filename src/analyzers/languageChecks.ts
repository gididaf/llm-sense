import { join, basename } from 'node:path';
import { readFile } from 'node:fs/promises';
import { stratifiedSample, readFileSafe, type WalkEntry } from '../core/fs.js';
import type { LanguageCheckResult, LanguageCheckFinding } from '../types.js';

// ─── Test path detection (skip penalties for test files) ──────────
const TEST_PATH_RE = /[/\\](tests?|spec|__tests__|fixtures?|mocks?|examples?)[/\\]/i;
const TEST_FILE_RE = /\.(test|spec)\.[^.]+$/;
function isTestPath(p: string): boolean {
  return TEST_PATH_RE.test(p) || TEST_FILE_RE.test(p);
}

// ─── Check & language spec types ──────────────────────────────────
interface CheckSpec {
  name: string;
  regex: RegExp;
  penaltyPerOccurrence: number;
  cap: number;
  filesFilter?: (entry: WalkEntry) => boolean;
}

interface LanguageSpec {
  extensions: string[];
  checks: CheckSpec[];
}

// ─── Language definitions ─────────────────────────────────────────
const LANGUAGES: Record<string, LanguageSpec> = {
  'TypeScript/JavaScript': {
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
    checks: [
      { name: 'any-type', regex: /:\s*any[\s;,)\]]/g, penaltyPerOccurrence: 1, cap: 10 },
      { name: 'barrel-reexport', regex: /export\s*\*\s*from/g, penaltyPerOccurrence: 0, cap: 0,
        filesFilter: (e) => /^index\.(ts|tsx|js|jsx|mjs|cjs)$/.test(basename(e.path)) },
      { name: 'dynamic-import', regex: /import\s*\(/g, penaltyPerOccurrence: 0, cap: 0 },
    ],
  },
  Python: {
    extensions: ['.py', '.pyx'],
    checks: [
      { name: 'missing-type-hints', regex: /def\s+\w+\s*\([^:)]+[,)]/g, penaltyPerOccurrence: 1, cap: 10 },
      { name: 'wildcard-import', regex: /from\s+\w+\s+import\s+\*/g, penaltyPerOccurrence: 2, cap: 8 },
    ],
  },
  Go: {
    extensions: ['.go'],
    checks: [
      { name: 'ignored-error', regex: /[^_]\s*,\s*_\s*[:=]/g, penaltyPerOccurrence: 1, cap: 10 },
      { name: 'no-exported-comment', regex: /^func\s+[A-Z]/gm, penaltyPerOccurrence: 0, cap: 0 },
    ],
  },
  Rust: {
    extensions: ['.rs'],
    checks: [
      { name: 'excessive-unwrap', regex: /\.unwrap\(\)/g, penaltyPerOccurrence: 1, cap: 10 },
      { name: 'unsafe-block', regex: /unsafe\s*\{/g, penaltyPerOccurrence: 0, cap: 0 },
    ],
  },
  'Java/Kotlin': {
    extensions: ['.java', '.kt', '.kts'],
    checks: [
      { name: 'raw-types', regex: /(List|Map|Set|Collection)\s+\w/g, penaltyPerOccurrence: 1, cap: 10 },
    ],
  },
  Ruby: {
    extensions: ['.rb'],
    checks: [
      { name: 'monkey-patching', regex: /class\s+(String|Array|Hash|Integer|Object)\b/g, penaltyPerOccurrence: 0, cap: 0 },
    ],
  },
  PHP: {
    extensions: ['.php'],
    checks: [
      { name: 'eval-usage', regex: /\beval\s*\(/g, penaltyPerOccurrence: 3, cap: 9 },
    ],
  },
  Swift: {
    extensions: ['.swift'],
    checks: [
      { name: 'force-unwrap', regex: /\w+!\.|as!\s/g, penaltyPerOccurrence: 1, cap: 10 },
    ],
  },
};

// ─── tsconfig strict check (special case) ─────────────────────────
async function checkTsStrict(rootPath: string): Promise<LanguageCheckFinding | null> {
  try {
    const content = await readFile(join(rootPath, 'tsconfig.json'), 'utf-8');
    if (!/"strict"\s*:\s*true/.test(content)) {
      return {
        check: 'strict-mode',
        language: 'TypeScript/JavaScript',
        file: 'tsconfig.json',
        line: 0,
        penalty: 5,
        message: 'tsconfig.json exists but "strict": true is not set',
      };
    }
  } catch {
    // No tsconfig — skip
  }
  return null;
}

// ─── Go exported-func comment check (needs previous line) ─────────
function checkGoExportedComments(lines: string[], file: string): LanguageCheckFinding[] {
  const findings: LanguageCheckFinding[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^func\s+[A-Z]/.test(lines[i])) {
      const prev = i > 0 ? lines[i - 1].trim() : '';
      if (!prev.startsWith('//')) {
        findings.push({
          check: 'no-exported-comment',
          language: 'Go',
          file,
          line: i + 1,
          penalty: 0,
          message: `Exported function without doc comment`,
        });
      }
    }
  }
  return findings;
}

// ─── Main export ──────────────────────────────────────────────────
export async function runLanguageChecks(
  entries: WalkEntry[],
): Promise<LanguageCheckResult[]> {
  const files = entries.filter(e => e.isFile);
  const rootPath = files.length > 0
    ? files[0].path.slice(0, files[0].path.length - files[0].relativePath.length - 1)
    : '.';

  // Group files by language
  const extToLang = new Map<string, string>();
  for (const [lang, spec] of Object.entries(LANGUAGES)) {
    for (const ext of spec.extensions) extToLang.set(ext, lang);
  }

  const langFiles = new Map<string, WalkEntry[]>();
  for (const f of files) {
    const lang = extToLang.get(f.ext);
    if (!lang) continue;
    if (!langFiles.has(lang)) langFiles.set(lang, []);
    langFiles.get(lang)!.push(f);
  }

  const results: LanguageCheckResult[] = [];

  for (const [lang, langEntries] of langFiles) {
    const spec = LANGUAGES[lang];
    const sampled = stratifiedSample(langEntries, 100);
    const checkAgg = new Map<string, { occurrences: number; penalty: number; cap: number }>();
    const findings: LanguageCheckFinding[] = [];

    for (const c of spec.checks) {
      checkAgg.set(c.name, { occurrences: 0, penalty: c.penaltyPerOccurrence, cap: c.cap });
    }

    // Special: tsconfig strict check for TS/JS
    if (lang === 'TypeScript/JavaScript') {
      const strictFinding = await checkTsStrict(rootPath);
      if (strictFinding) {
        findings.push(strictFinding);
        checkAgg.set('strict-mode', { occurrences: 1, penalty: 5, cap: 5 });
      }
    }

    for (const entry of sampled) {
      const content = await readFileSafe(entry.path, 25_000);
      const lines = content.split('\n').slice(0, 500);
      const isTest = isTestPath(entry.relativePath);

      // Special handling: Go exported comment check needs line-by-line context
      if (lang === 'Go') {
        const goFindings = checkGoExportedComments(lines, entry.relativePath);
        findings.push(...goFindings);
        const agg = checkAgg.get('no-exported-comment')!;
        agg.occurrences += goFindings.length;
        // Skip normal regex for this check
      }

      const text = lines.join('\n');

      for (const check of spec.checks) {
        if (check.name === 'no-exported-comment' && lang === 'Go') continue;
        if (check.filesFilter && !check.filesFilter(entry)) continue;

        const regex = new RegExp(check.regex.source, check.regex.flags);
        let match: RegExpExecArray | null;
        while ((match = regex.exec(text)) !== null) {
          const lineNum = text.slice(0, match.index).split('\n').length;
          const finding: LanguageCheckFinding = {
            check: check.name,
            language: lang,
            file: entry.relativePath,
            line: lineNum,
            penalty: isTest ? 0 : check.penaltyPerOccurrence,
            message: `${check.name}: ${match[0].trim()}`,
          };
          findings.push(finding);
          const agg = checkAgg.get(check.name)!;
          if (!isTest) agg.occurrences++;
        }
      }
    }

    // Compute total penalty with caps
    let totalPenalty = 0;
    const checks: LanguageCheckResult['checks'] = [];
    for (const [name, agg] of checkAgg) {
      const raw = agg.occurrences * agg.penalty;
      const capped = agg.cap > 0 ? Math.min(raw, agg.cap) : raw;
      totalPenalty += capped;
      checks.push({ name, occurrences: agg.occurrences, penalty: agg.penalty, cap: agg.cap });
    }

    results.push({
      language: lang,
      checks,
      totalPenalty,
      findings,
      filesScanned: sampled.length,
    });
  }

  return results;
}
