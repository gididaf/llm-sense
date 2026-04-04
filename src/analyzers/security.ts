import { access, readFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import type { WalkEntry } from '../core/fs.js';
import { stratifiedSample, readFileSafe } from '../core/fs.js';
import type { SecurityResult, SecurityFinding } from '../types.js';

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// Regex for hardcoded secrets: matches key=value patterns where value is 8+ chars
const SECRET_PATTERN =
  /(api[_-]?key|secret[_-]?key|api[_-]?secret|password|auth[_-]?token|access[_-]?token|private[_-]?key|client[_-]?secret)\s*[:=]\s*['"][^'"]{8,}['"]/i;

// Sensitive file patterns
const SENSITIVE_FILE_PATTERNS = [
  /\.pem$/,
  /\.key$/,
  /^credentials\./,
  /^secrets\./,
  /\.pfx$/,
  /\.p12$/,
  /^\.env\.local$/,
  /^\.env\.production$/,
];

// Test path patterns to skip for secret scanning
const TEST_PATH_PATTERNS = [
  /[/\\]tests?[/\\]/i,
  /[/\\]__tests__[/\\]/i,
  /[/\\]fixtures?[/\\]/i,
  /[/\\]mocks?[/\\]/i,
  /\.test\.[^.]+$/,
  /\.spec\.[^.]+$/,
  /[/\\]examples?[/\\]/i,
  /[/\\]docs?[/\\]/i,
];

function isTestPath(filePath: string): boolean {
  return TEST_PATH_PATTERNS.some(p => p.test(filePath));
}

export async function analyzeSecurity(
  rootPath: string,
  entries: WalkEntry[],
): Promise<SecurityResult> {
  const findings: SecurityFinding[] = [];
  let score = 100;

  const hasGitignore = await fileExists(join(rootPath, '.gitignore'));
  let envExposed = false;
  const hardcodedSecretFiles: string[] = [];
  const sensitiveFilesTracked: string[] = [];
  let missingLockfile = false;

  // 1. Check for .gitignore existence (-5)
  if (!hasGitignore) {
    const pts = 5;
    score -= pts;
    findings.push({
      check: 'No .gitignore',
      severity: 'medium',
      detail: 'Repository has no .gitignore file — risk of committing secrets or build artifacts',
      pointsDeducted: pts,
    });
  }

  // 2. Check if .env is committed (not in .gitignore) (-10)
  const envExists = await fileExists(join(rootPath, '.env'));
  if (envExists) {
    let envIgnored = false;
    if (hasGitignore) {
      try {
        const gitignore = await readFile(join(rootPath, '.gitignore'), 'utf-8');
        envIgnored = /^\.env$/m.test(gitignore) || /^\*\.env$/m.test(gitignore) || /^\.env\*$/m.test(gitignore);
      } catch {}
    }
    if (!envIgnored) {
      envExposed = true;
      const pts = 10;
      score -= pts;
      findings.push({
        check: '.env file exposed',
        severity: 'high',
        detail: '.env file exists but is not in .gitignore — secrets may be committed to version control',
        pointsDeducted: pts,
      });
    }
  }

  // 3. Check for sensitive files tracked in the tree (-5 per file, cap -15)
  let sensitiveFilesPenalty = 0;
  for (const entry of entries) {
    if (!entry.isFile) continue;
    const name = basename(entry.path);
    if (SENSITIVE_FILE_PATTERNS.some(p => p.test(name))) {
      sensitiveFilesTracked.push(entry.path);
      const pts = Math.min(5, 15 - sensitiveFilesPenalty);
      if (pts > 0) {
        sensitiveFilesPenalty += pts;
        score -= pts;
      }
    }
  }
  if (sensitiveFilesTracked.length > 0) {
    findings.push({
      check: 'Sensitive files tracked',
      severity: 'high',
      detail: `${sensitiveFilesTracked.length} sensitive file(s) found in tree: ${sensitiveFilesTracked.slice(0, 3).map(p => basename(p)).join(', ')}${sensitiveFilesTracked.length > 3 ? '...' : ''}`,
      pointsDeducted: sensitiveFilesPenalty,
    });
  }

  // 4. Check for hardcoded secrets in source files (-5 per file, cap -20)
  const sourceEntries = entries.filter(e => e.isFile && !isTestPath(e.path));
  const sampled = stratifiedSample(sourceEntries, 300);
  let secretPenalty = 0;

  for (const entry of sampled) {
    if (secretPenalty >= 20) break;
    const content = await readFileSafe(entry.path, 16384); // 16KB
    if (!content) continue;

    // Skip comments-only matches by checking the line isn't a comment
    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
      if (SECRET_PATTERN.test(trimmed)) {
        hardcodedSecretFiles.push(entry.path);
        const pts = Math.min(5, 20 - secretPenalty);
        secretPenalty += pts;
        score -= pts;
        break;
      }
    }
  }
  if (hardcodedSecretFiles.length > 0) {
    findings.push({
      check: 'Hardcoded secrets',
      severity: 'high',
      detail: `${hardcodedSecretFiles.length} file(s) contain potential hardcoded secrets: ${hardcodedSecretFiles.slice(0, 3).map(p => basename(p)).join(', ')}${hardcodedSecretFiles.length > 3 ? '...' : ''}`,
      pointsDeducted: secretPenalty,
    });
  }

  // 5. Check for missing dependency lockfile (-5)
  const hasDependencyFile =
    await fileExists(join(rootPath, 'package.json')) ||
    await fileExists(join(rootPath, 'requirements.txt')) ||
    await fileExists(join(rootPath, 'Pipfile')) ||
    await fileExists(join(rootPath, 'pyproject.toml')) ||
    await fileExists(join(rootPath, 'Gemfile')) ||
    await fileExists(join(rootPath, 'go.mod')) ||
    await fileExists(join(rootPath, 'Cargo.toml'));

  const hasLockfile =
    await fileExists(join(rootPath, 'package-lock.json')) ||
    await fileExists(join(rootPath, 'yarn.lock')) ||
    await fileExists(join(rootPath, 'pnpm-lock.yaml')) ||
    await fileExists(join(rootPath, 'bun.lockb')) ||
    await fileExists(join(rootPath, 'Pipfile.lock')) ||
    await fileExists(join(rootPath, 'poetry.lock')) ||
    await fileExists(join(rootPath, 'Gemfile.lock')) ||
    await fileExists(join(rootPath, 'go.sum')) ||
    await fileExists(join(rootPath, 'Cargo.lock'));

  if (hasDependencyFile && !hasLockfile) {
    missingLockfile = true;
    const pts = 5;
    score -= pts;
    findings.push({
      check: 'Missing lockfile',
      severity: 'medium',
      detail: 'Dependency file found but no lockfile — builds may not be reproducible',
      pointsDeducted: pts,
    });
  }

  return {
    score: Math.max(0, score),
    findings,
    hasGitignore,
    envExposed,
    hardcodedSecretFiles,
    sensitiveFilesTracked,
    missingLockfile,
  };
}
