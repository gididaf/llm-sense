import { access, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { WalkEntry } from '../core/fs.js';
import type { DevInfraResult } from '../types.js';

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// Lightweight DevOps infrastructure detection.
// Checks for CI, testing, linting, pre-commit hooks, and type checking
// without heavy analysis — purely file existence and simple content checks.
export async function analyzeDevInfra(
  rootPath: string,
  entries: WalkEntry[],
): Promise<DevInfraResult> {
  let score = 0;
  const ciFiles: string[] = [];

  // CI config detection (5 pts)
  const ciPatterns = [
    '.github/workflows',
    '.gitlab-ci.yml',
    'Jenkinsfile',
    '.circleci/config.yml',
    '.travis.yml',
    'azure-pipelines.yml',
    'bitbucket-pipelines.yml',
  ];

  // Check for .github/workflows/*.yml (walkDir skips dotdirs, so read directly)
  try {
    const workflowDir = join(rootPath, '.github', 'workflows');
    const files = await readdir(workflowDir);
    const ymlFiles = files.filter(f => f.endsWith('.yml') || f.endsWith('.yaml'));
    if (ymlFiles.length > 0) {
      ciFiles.push(...ymlFiles.map(f => `.github/workflows/${f}`));
    }
  } catch {}

  // Check for other CI configs
  for (const pattern of ciPatterns.slice(1)) {
    if (await fileExists(join(rootPath, pattern))) {
      ciFiles.push(pattern);
    }
  }

  const hasCi = ciFiles.length > 0;
  if (hasCi) score += 5;

  // Test command detection (5 pts)
  let hasTestCommand = false;

  // package.json scripts.test — check root and workspace packages
  const pkgJsonPaths = [
    join(rootPath, 'package.json'),
    ...entries.filter(e => e.isFile && e.name === 'package.json').map(e => e.path),
  ];
  for (const pkgPath of pkgJsonPaths) {
    try {
      const content = await readFile(pkgPath, 'utf-8');
      const pkg = JSON.parse(content);
      if (pkg.scripts?.test && pkg.scripts.test !== 'echo "Error: no test specified" && exit 1') {
        hasTestCommand = true;
        break;
      }
    } catch {}
  }

  // Makefile test target
  if (!hasTestCommand) {
    try {
      const makefile = await readFile(join(rootPath, 'Makefile'), 'utf-8');
      if (/^test\s*:/m.test(makefile)) hasTestCommand = true;
    } catch {}
  }

  // pytest.ini, setup.cfg [tool:pytest], pyproject.toml [tool.pytest]
  if (!hasTestCommand) {
    if (await fileExists(join(rootPath, 'pytest.ini'))) hasTestCommand = true;
    if (await fileExists(join(rootPath, 'jest.config.ts'))) hasTestCommand = true;
    if (await fileExists(join(rootPath, 'jest.config.js'))) hasTestCommand = true;
    if (await fileExists(join(rootPath, 'vitest.config.ts'))) hasTestCommand = true;
    if (await fileExists(join(rootPath, 'vitest.config.js'))) hasTestCommand = true;
  }

  if (hasTestCommand) score += 5;

  // Linter config detection (3 pts)
  const linterFiles = [
    '.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yml',
    'eslint.config.js', 'eslint.config.mjs', 'eslint.config.ts',
    '.prettierrc', '.prettierrc.js', '.prettierrc.json', '.prettierrc.yml',
    'prettier.config.js', 'prettier.config.mjs',
    'biome.json', 'biome.jsonc',
    '.stylelintrc', '.stylelintrc.json',
  ];

  let hasLinterConfig = false;
  for (const file of linterFiles) {
    if (await fileExists(join(rootPath, file))) {
      hasLinterConfig = true;
      break;
    }
  }
  // Also check entries for linter configs in workspaces
  if (!hasLinterConfig) {
    const linterNames = new Set(linterFiles.map(f => f.split('/').pop()!));
    hasLinterConfig = entries.some(e => e.isFile && linterNames.has(e.name));
  }

  // Also check pyproject.toml for [tool.ruff] or [tool.flake8]
  if (!hasLinterConfig) {
    try {
      const pyproject = await readFile(join(rootPath, 'pyproject.toml'), 'utf-8');
      if (/\[tool\.(ruff|flake8|pylint|black)\]/i.test(pyproject)) hasLinterConfig = true;
    } catch {}
  }

  if (hasLinterConfig) score += 3;

  // Pre-commit hooks detection (3 pts)
  let hasPreCommitHooks = false;
  if (await fileExists(join(rootPath, '.husky'))) hasPreCommitHooks = true;
  if (await fileExists(join(rootPath, '.pre-commit-config.yaml'))) hasPreCommitHooks = true;
  if (await fileExists(join(rootPath, '.lefthook.yml'))) hasPreCommitHooks = true;

  if (hasPreCommitHooks) score += 3;

  // Type checking detection (4 pts)
  let hasTypeChecking = false;

  // tsconfig.json — check root and workspace packages
  const tsconfigPaths = [
    join(rootPath, 'tsconfig.json'),
    ...entries.filter(e => e.isFile && e.name === 'tsconfig.json').map(e => e.path),
  ];
  for (const tscPath of tsconfigPaths) {
    try {
      await readFile(tscPath, 'utf-8');
      hasTypeChecking = true;
      break;
    } catch {}
  }

  // mypy.ini or pyright
  if (!hasTypeChecking) {
    if (await fileExists(join(rootPath, 'mypy.ini'))) hasTypeChecking = true;
    if (await fileExists(join(rootPath, 'pyrightconfig.json'))) hasTypeChecking = true;
    // pyproject.toml with [tool.mypy] or [tool.pyright]
    try {
      const pyproject = await readFile(join(rootPath, 'pyproject.toml'), 'utf-8');
      if (/\[tool\.(mypy|pyright)\]/i.test(pyproject)) hasTypeChecking = true;
    } catch {}
  }

  if (hasTypeChecking) score += 4;

  return {
    hasCi,
    hasTestCommand,
    hasLinterConfig,
    hasPreCommitHooks,
    hasTypeChecking,
    ciFiles,
    score,
  };
}
