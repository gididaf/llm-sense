import { access, readFile, readdir, stat } from 'node:fs/promises';
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
// Checks for CI, testing, linting, pre-commit hooks, type checking,
// devcontainer, task discovery, and observability.
export async function analyzeDevInfra(
  rootPath: string,
  entries: WalkEntry[],
): Promise<DevInfraResult> {
  let score = 0;
  const ciFiles: string[] = [];

  // ─── CI config detection (3 pts) ────────────────────────

  const ciPatterns = [
    '.github/workflows',
    '.gitlab-ci.yml',
    'Jenkinsfile',
    '.circleci/config.yml',
    '.travis.yml',
    'azure-pipelines.yml',
    'bitbucket-pipelines.yml',
  ];

  try {
    const workflowDir = join(rootPath, '.github', 'workflows');
    const files = await readdir(workflowDir);
    const ymlFiles = files.filter(f => f.endsWith('.yml') || f.endsWith('.yaml'));
    if (ymlFiles.length > 0) {
      ciFiles.push(...ymlFiles.map(f => `.github/workflows/${f}`));
    }
  } catch {}

  for (const pattern of ciPatterns.slice(1)) {
    if (await fileExists(join(rootPath, pattern))) {
      ciFiles.push(pattern);
    }
  }

  const hasCi = ciFiles.length > 0;
  if (hasCi) score += 3;

  // ─── Test command detection (3 pts) ─────────────────────

  let hasTestCommand = false;

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

  if (!hasTestCommand) {
    try {
      const makefile = await readFile(join(rootPath, 'Makefile'), 'utf-8');
      if (/^test\s*:/m.test(makefile)) hasTestCommand = true;
    } catch {}
  }

  if (!hasTestCommand) {
    if (await fileExists(join(rootPath, 'pytest.ini'))) hasTestCommand = true;
    if (await fileExists(join(rootPath, 'jest.config.ts'))) hasTestCommand = true;
    if (await fileExists(join(rootPath, 'jest.config.js'))) hasTestCommand = true;
    if (await fileExists(join(rootPath, 'vitest.config.ts'))) hasTestCommand = true;
    if (await fileExists(join(rootPath, 'vitest.config.js'))) hasTestCommand = true;
  }

  if (hasTestCommand) score += 3;

  // ─── Linter config detection (2 pts) ────────────────────

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
  if (!hasLinterConfig) {
    const linterNames = new Set(linterFiles.map(f => f.split('/').pop()!));
    hasLinterConfig = entries.some(e => e.isFile && linterNames.has(e.name));
  }
  if (!hasLinterConfig) {
    try {
      const pyproject = await readFile(join(rootPath, 'pyproject.toml'), 'utf-8');
      if (/\[tool\.(ruff|flake8|pylint|black)\]/i.test(pyproject)) hasLinterConfig = true;
    } catch {}
  }

  if (hasLinterConfig) score += 2;

  // ─── Pre-commit hooks detection (2 pts) ─────────────────

  let hasPreCommitHooks = false;
  if (await fileExists(join(rootPath, '.husky'))) hasPreCommitHooks = true;
  if (await fileExists(join(rootPath, '.pre-commit-config.yaml'))) hasPreCommitHooks = true;
  if (await fileExists(join(rootPath, '.lefthook.yml'))) hasPreCommitHooks = true;

  if (hasPreCommitHooks) score += 2;

  // ─── Type checking detection (2 pts) ────────────────────

  let hasTypeChecking = false;

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

  if (!hasTypeChecking) {
    if (await fileExists(join(rootPath, 'mypy.ini'))) hasTypeChecking = true;
    if (await fileExists(join(rootPath, 'pyrightconfig.json'))) hasTypeChecking = true;
    try {
      const pyproject = await readFile(join(rootPath, 'pyproject.toml'), 'utf-8');
      if (/\[tool\.(mypy|pyright)\]/i.test(pyproject)) hasTypeChecking = true;
    } catch {}
  }

  if (hasTypeChecking) score += 2;

  // ─── Devcontainer / Codespaces (3 pts) ──────────────────

  let hasDevcontainer = false;
  const devcontainerFeatures: string[] = [];

  try {
    const dcPath = join(rootPath, '.devcontainer', 'devcontainer.json');
    const dcContent = await readFile(dcPath, 'utf-8');
    hasDevcontainer = true;
    devcontainerFeatures.push('devcontainer.json');

    if (dcContent.includes('postCreateCommand')) devcontainerFeatures.push('postCreateCommand');
    if (dcContent.includes('Dockerfile') || dcContent.includes('image')) devcontainerFeatures.push('image/Dockerfile');
    if (dcContent.includes('extensions') || dcContent.includes('customizations')) devcontainerFeatures.push('extensions');
  } catch {}

  if (!hasDevcontainer) {
    // Check for Dockerfile in .devcontainer even without devcontainer.json
    if (await fileExists(join(rootPath, '.devcontainer', 'Dockerfile'))) {
      hasDevcontainer = true;
      devcontainerFeatures.push('Dockerfile');
    }
  }

  // Docker Compose for multi-service setups
  if (await fileExists(join(rootPath, '.devcontainer', 'docker-compose.yml')) ||
      await fileExists(join(rootPath, '.devcontainer', 'docker-compose.yaml'))) {
    devcontainerFeatures.push('docker-compose');
  }

  if (hasDevcontainer) score += 3;

  // ─── Task Discovery (3 pts) ─────────────────────────────

  let hasIssueTemplates = false;
  let hasPrTemplate = false;
  let hasContributing = false;
  let hasChangelog = false;

  // Issue templates
  try {
    const templateDir = join(rootPath, '.github', 'ISSUE_TEMPLATE');
    const files = await readdir(templateDir);
    if (files.length > 0) hasIssueTemplates = true;
  } catch {}

  // PR template
  if (await fileExists(join(rootPath, '.github', 'PULL_REQUEST_TEMPLATE.md')) ||
      await fileExists(join(rootPath, '.github', 'pull_request_template.md'))) {
    hasPrTemplate = true;
  }
  if (!hasPrTemplate) {
    try {
      const prDir = join(rootPath, '.github', 'PULL_REQUEST_TEMPLATE');
      const files = await readdir(prDir);
      if (files.length > 0) hasPrTemplate = true;
    } catch {}
  }

  // Contributing guide
  if (await fileExists(join(rootPath, 'CONTRIBUTING.md')) ||
      await fileExists(join(rootPath, 'contributing.md'))) {
    try {
      const content = await readFile(join(rootPath, 'CONTRIBUTING.md'), 'utf-8').catch(() =>
        readFile(join(rootPath, 'contributing.md'), 'utf-8'));
      const lineCount = content.split('\n').length;
      if (lineCount > 20) hasContributing = true;
    } catch {}
  }

  // Changelog
  if (await fileExists(join(rootPath, 'CHANGELOG.md')) ||
      await fileExists(join(rootPath, 'RELEASES.md')) ||
      await fileExists(join(rootPath, 'HISTORY.md'))) {
    hasChangelog = true;
  }

  // TODO/FIXME count (sample source files)
  let todoCount = 0;
  const sourceEntries = entries.filter(e => e.isFile && /\.(ts|tsx|js|jsx|py|go|rs|java|rb|php|swift)$/.test(e.name));
  const sampleSize = Math.min(sourceEntries.length, 200);
  const sampleEntries = sourceEntries.slice(0, sampleSize);
  for (const entry of sampleEntries) {
    try {
      const content = await readFile(entry.path, 'utf-8');
      const matches = content.match(/\b(TODO|FIXME|HACK|XXX)\b/g);
      if (matches) todoCount += matches.length;
    } catch {}
  }
  // Extrapolate if we sampled
  if (sourceEntries.length > sampleSize) {
    todoCount = Math.round(todoCount * (sourceEntries.length / sampleSize));
  }

  // Task discovery score: 1pt for issue templates, 1pt for PR template or contributing, 1pt for changelog
  if (hasIssueTemplates) score += 1;
  if (hasPrTemplate || hasContributing) score += 1;
  if (hasChangelog) score += 1;

  // ─── Observability (2 pts) ──────────────────────────────

  let hasStructuredLogging = false;
  let hasEnvExample = false;
  let hasHealthCheck = false;
  let hasOpenTelemetry = false;

  // Structured logging library detection via package.json deps or imports
  const loggingLibs = ['winston', 'pino', 'bunyan', 'log4js', 'morgan', 'signale',
    'logrus', 'zerolog', 'slog', 'tracing', 'spdlog', 'log4j', 'slf4j', 'logback'];

  // Check package.json
  try {
    const pkg = JSON.parse(await readFile(join(rootPath, 'package.json'), 'utf-8'));
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const lib of loggingLibs) {
      if (allDeps[lib]) { hasStructuredLogging = true; break; }
    }
  } catch {}

  // Check Go/Rust/Python deps
  if (!hasStructuredLogging) {
    try {
      const goMod = await readFile(join(rootPath, 'go.mod'), 'utf-8');
      if (/logrus|zerolog|zap|slog/.test(goMod)) hasStructuredLogging = true;
    } catch {}
    try {
      const cargoToml = await readFile(join(rootPath, 'Cargo.toml'), 'utf-8');
      if (/tracing|slog|env_logger|log4rs/.test(cargoToml)) hasStructuredLogging = true;
    } catch {}
    try {
      const reqs = await readFile(join(rootPath, 'requirements.txt'), 'utf-8');
      if (/structlog|loguru|logging/.test(reqs)) hasStructuredLogging = true;
    } catch {}
  }

  // .env.example or .env.template
  if (await fileExists(join(rootPath, '.env.example')) ||
      await fileExists(join(rootPath, '.env.template')) ||
      await fileExists(join(rootPath, '.env.sample'))) {
    hasEnvExample = true;
  }

  // Health check endpoint detection (search for common patterns)
  const healthPatterns = ['/health', '/healthz', '/readiness', '/ready', '/ping', '/status'];
  const routeFiles = entries.filter(e => e.isFile && /\b(route|controller|handler|server|app|health)\b/i.test(e.name));
  for (const entry of routeFiles.slice(0, 20)) {
    try {
      const content = await readFile(entry.path, 'utf-8');
      if (healthPatterns.some(p => content.includes(p))) {
        hasHealthCheck = true;
        break;
      }
    } catch {}
  }

  // OpenTelemetry detection
  try {
    const pkg = JSON.parse(await readFile(join(rootPath, 'package.json'), 'utf-8'));
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (Object.keys(allDeps).some(k => k.includes('opentelemetry'))) hasOpenTelemetry = true;
  } catch {}
  if (!hasOpenTelemetry) {
    try {
      const goMod = await readFile(join(rootPath, 'go.mod'), 'utf-8');
      if (goMod.includes('opentelemetry')) hasOpenTelemetry = true;
    } catch {}
  }

  // Observability score: 1pt for structured logging, 1pt for env example or health check or otel
  if (hasStructuredLogging) score += 1;
  if (hasEnvExample || hasHealthCheck || hasOpenTelemetry) score += 1;

  return {
    hasCi,
    hasTestCommand,
    hasLinterConfig,
    hasPreCommitHooks,
    hasTypeChecking,
    ciFiles,
    hasDevcontainer,
    devcontainerFeatures,
    hasIssueTemplates,
    hasPrTemplate,
    hasContributing,
    hasChangelog,
    todoCount,
    hasStructuredLogging,
    hasEnvExample,
    hasHealthCheck,
    hasOpenTelemetry,
    score,
  };
}
