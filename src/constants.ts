export const SCORING_WEIGHTS = {
  documentation: 0.18,
  taskCompletion: 0.20,
  fileSizes: 0.12,
  structure: 0.08,
  modularity: 0.10,
  contextEfficiency: 0.08,
  tokenEfficiency: 0.10,
  naming: 0.04,
  devInfra: 0.05,
  coupling: 0.05,
} as const;

export const SCORING_WEIGHTS_NO_EMPIRICAL = {
  documentation: 0.25,
  taskCompletion: 0,
  fileSizes: 0.17,
  structure: 0.10,
  modularity: 0.13,
  contextEfficiency: 0.13,
  tokenEfficiency: 0,
  naming: 0.07,
  devInfra: 0.08,
  coupling: 0.07,
} as const;

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
