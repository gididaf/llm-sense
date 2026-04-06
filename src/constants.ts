export const SCORING_WEIGHTS: Record<string, number> = {
  documentation: 0.16,
  taskCompletion: 0.17,
  fileSizes: 0.10,
  structure: 0.07,
  modularity: 0.08,
  contextEfficiency: 0.07,
  tokenEfficiency: 0.10,
  naming: 0.03,
  devInfra: 0.05,
  coupling: 0.05,
  security: 0.08,
  codeQuality: 0.04,
};

export const SCORING_WEIGHTS_NO_EMPIRICAL: Record<string, number> = {
  documentation: 0.21,
  taskCompletion: 0,
  fileSizes: 0.14,
  structure: 0.08,
  modularity: 0.10,
  contextEfficiency: 0.10,
  tokenEfficiency: 0,
  naming: 0.05,
  devInfra: 0.07,
  coupling: 0.06,
  security: 0.13,
  codeQuality: 0.06,
};

export const SCORING_VERSION = '1.3.0';

// ─── Difficulty-Tiered Empirical Testing ──────────────────
export const DIFFICULTY_WEIGHTS = { easy: 0.5, medium: 1.0, hard: 2.0 } as const;
export const DIFFICULTY_DISTRIBUTION = { easy: 0.4, medium: 0.4, hard: 0.2 } as const;

// ─── Custom Scoring Profiles ───────────────────────────

export const SCORING_PROFILES: Record<string, Record<string, number>> = {
  default: SCORING_WEIGHTS,
  'static-only': SCORING_WEIGHTS_NO_EMPIRICAL,

  strict: {
    documentation: 0.19,
    taskCompletion: 0.14,
    fileSizes: 0.10,
    structure: 0.07,
    modularity: 0.09,
    contextEfficiency: 0.07,
    tokenEfficiency: 0.07,
    naming: 0.04,
    devInfra: 0.05,
    coupling: 0.05,
    security: 0.07,
    codeQuality: 0.06,
  },

  docs: {
    documentation: 0.33,
    taskCompletion: 0.14,
    fileSizes: 0.07,
    structure: 0.04,
    modularity: 0.06,
    contextEfficiency: 0.05,
    tokenEfficiency: 0.07,
    naming: 0.03,
    devInfra: 0.04,
    coupling: 0.04,
    security: 0.06,
    codeQuality: 0.07,
  },

  security: {
    documentation: 0.11,
    taskCompletion: 0.11,
    fileSizes: 0.07,
    structure: 0.05,
    modularity: 0.07,
    contextEfficiency: 0.06,
    tokenEfficiency: 0.07,
    naming: 0.04,
    devInfra: 0.06,
    coupling: 0.05,
    security: 0.24,
    codeQuality: 0.07,
  },
};

// ─── Fixed Cost Estimates for Auto-Improve ──────────────

export const COST_ESTIMATES = {
  structuredCall: 0.10,  // callClaudeStructured
  agentCall: 0.30,       // callClaude (full agent mode)
  staticAnalysis: 0.00,  // free (no LLM)
};

export const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.nuxt',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
  'vendor',
  '.idea',
  '.vscode',
  'target',
  'out',
  '.cache',
  '.turbo',
  '.parcel-cache',
  '.svelte-kit',
  'android',
  'ios',
  '.expo',
]);

export const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.webp', '.avif',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.mp3', '.mp4', '.wav', '.ogg', '.webm',
  '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx',
  '.exe', '.dll', '.so', '.dylib',
  '.pyc', '.pyo', '.class', '.o',
  '.sqlite', '.db',
]);

export const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.pyx',
  '.rs',
  '.go',
  '.java', '.kt', '.kts', '.scala',
  '.rb',
  '.php',
  '.c', '.cpp', '.cc', '.cxx', '.h', '.hpp',
  '.cs',
  '.swift',
  '.dart',
  '.vue', '.svelte', '.astro',
  '.lua',
  '.zig',
  '.ex', '.exs',
  '.elm', '.hs',
  '.r', '.R',
  '.sql',
  '.sh', '.bash', '.zsh',
]);

export const GENERATED_PATTERNS = [
  /\.min\.(js|css)$/,
  /\.generated\./,
  /\.d\.ts$/,
  /\.map$/,
  /package-lock\.json$/,
  /pnpm-lock\.yaml$/,
  /yarn\.lock$/,
  /Gemfile\.lock$/,
  /Cargo\.lock$/,
  /poetry\.lock$/,
  /composer\.lock$/,
  /go\.sum$/,
];

export const LOCKFILE_NAMES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'Gemfile.lock',
  'Cargo.lock',
  'poetry.lock',
  'composer.lock',
  'go.sum',
  'Pipfile.lock',
]);

export const DEPENDENCY_FILE_NAMES = new Set([
  'package.json',
  'requirements.txt',
  'Pipfile',
  'pyproject.toml',
  'setup.py',
  'Cargo.toml',
  'go.mod',
  'Gemfile',
  'composer.json',
  'build.gradle',
  'pom.xml',
]);

export const CLAUDE_MD_SECTIONS: Record<string, { name: string; keywords: string[] }> = {
  architectureOverview: { name: 'Architecture Overview', keywords: ['architecture', 'overview', 'structure', 'design', 'high-level', 'system'] },
  moduleMap: { name: 'Module Map', keywords: ['module', 'dependency', 'component', 'diagram', 'map', 'graph', 'package'] },
  commonPatterns: { name: 'Common Patterns', keywords: ['pattern', 'how to add', 'how to create', 'example', 'convention', 'workflow'] },
  testingConventions: { name: 'Testing', keywords: ['test', 'testing', 'spec', 'jest', 'vitest', 'pytest', 'playwright'] },
  buildRunDeploy: { name: 'Build/Run/Deploy', keywords: ['build', 'run', 'deploy', 'start', 'install', 'script', 'npm', 'pnpm'] },
  gotchas: { name: 'Gotchas', keywords: ['gotcha', 'pitfall', 'warning', 'caveat', 'watch out', 'important', 'avoid', 'careful'] },
  techStack: { name: 'Tech Stack', keywords: ['stack', 'technolog', 'framework', 'language', 'tool', 'database'] },
  environmentSetup: { name: 'Environment Setup', keywords: ['setup', 'environment', 'env', 'config', 'prerequisite', 'requirement', '.env'] },
};

export const VIBE_CODER_FILES: Record<string, { path: string; name: string }> = {
  claudeDir: { path: '.claude', name: 'Claude Code' },
  cursorRules: { path: '.cursorrules', name: 'Cursor AI' },
  cursorIgnore: { path: '.cursorignore', name: 'Cursor AI' },
  copilotInstructions: { path: '.github/copilot-instructions.md', name: 'GitHub Copilot' },
  clineRules: { path: '.clinerules', name: 'Cline AI' },
};
