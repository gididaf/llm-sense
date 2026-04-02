import { z } from 'zod';

// ─── CLI Options ──────────────────────────────────────────

export interface CliOptions {
  path: string;
  bugs: number;
  features: number;
  output: string;
  maxBudgetPerTask: number;
  maxTurnsPerTask: number;
  skipEmpirical: boolean;
  model?: string;
  verbose: boolean;
  history: boolean;
}

// ─── Phase 1: Static Analysis ─────────────────────────────

export interface FileInfo {
  path: string;
  lines: number;
  bytes: number;
}

export interface FileSizeDistribution {
  totalFiles: number;
  totalLines: number;
  avgLines: number;
  medianLines: number;
  p90Lines: number;
  p99Lines: number;
  filesOver500Lines: number;
  filesOver1000Lines: number;
  largestFiles: FileInfo[];
}

export interface DirectoryStructureResult {
  maxDepth: number;
  avgDepth: number;
  totalDirs: number;
  deepestPaths: string[];
  avgFilesPerDir: number;
  maxFilesInDir: { path: string; count: number };
}

export interface NamingResult {
  conventionScore: number;
  inconsistencies: string[];
  dominantConvention: string;
  totalFilesAnalyzed: number;
}

export interface ClaudeMdContentScore {
  sections: Record<string, { found: boolean; score: number }>;
  overallContentScore: number;
  missingSections: string[];
  rawContent: string;
}

export interface VibeCoderContextFiles {
  hasClaudeDir: boolean;
  hasCursorRules: boolean;
  hasCursorIgnore: boolean;
  hasCopilotInstructions: boolean;
  hasClineRules: boolean;
  subdirectoryClaudeMdPaths: string[];
  detectedTools: string[];
}

export interface DocumentationResult {
  hasReadme: boolean;
  hasClaudeMd: boolean;
  readmeLines: number;
  claudeMdLines: number;
  inlineCommentRatio: number;
  totalSourceFiles: number;
  claudeMdContent: ClaudeMdContentScore | null;
  vibeCoderContext: VibeCoderContextFiles;
}

export interface ImportsResult {
  avgImportsPerFile: number;
  maxImportsInFile: { path: string; count: number };
  circularDeps: string[][];
  externalDependencyCount: number;
}

export interface ModularityResult {
  avgFilesPerDirectory: number;
  maxFilesInDirectory: { path: string; count: number };
  singleFileDirectories: number;
  totalDirectories: number;
  barrelExportCount: number;
}

export interface NoiseResult {
  generatedFileCount: number;
  lockfileBytes: number;
  binaryFileCount: number;
  sourceToNoiseRatio: number;
  totalFiles: number;
  sourceFiles: number;
}

export interface StaticAnalysisResult {
  fileSizes: FileSizeDistribution;
  directoryStructure: DirectoryStructureResult;
  naming: NamingResult;
  documentation: DocumentationResult;
  imports: ImportsResult;
  modularity: ModularityResult;
  noise: NoiseResult;
}

// ─── Phase 2: LLM Understanding ──────────────────────────

export const CodebaseUnderstandingSchema = z.object({
  projectName: z.string(),
  description: z.string(),
  techStack: z.array(z.object({
    name: z.string(),
    category: z.enum(['language', 'framework', 'library', 'tool', 'database', 'infra']),
    role: z.string(),
  })),
  architecture: z.object({
    pattern: z.string(),
    entryPoints: z.array(z.string()),
    keyAbstractions: z.array(z.string()),
    dataFlow: z.string(),
  }),
  conventions: z.object({
    testingApproach: z.string(),
    errorHandling: z.string(),
    stateManagement: z.string(),
    codeOrganization: z.string(),
  }),
  complexity: z.enum(['trivial', 'simple', 'moderate', 'complex', 'very-complex']),
  llmFriendlinessNotes: z.array(z.string()),
  contextWindowEstimate: z.object({
    totalTokensEstimate: z.number(),
    fitsInSingleContext: z.boolean(),
    keyFilesTokenEstimate: z.number(),
  }),
});

export type CodebaseUnderstanding = z.infer<typeof CodebaseUnderstandingSchema>;

// ─── Phase 3: Task Generation ─────────────────────────────

export const SyntheticTaskSchema = z.object({
  id: z.string(),
  type: z.enum(['bug', 'feature']),
  title: z.string(),
  description: z.string(),
  difficulty: z.enum(['easy', 'medium', 'hard']),
  expectedFilesTouch: z.array(z.string()),
  acceptanceCriteria: z.array(z.string()),
});

export type SyntheticTask = z.infer<typeof SyntheticTaskSchema>;

export const TaskGenerationResponseSchema = z.object({
  bugs: z.array(SyntheticTaskSchema),
  features: z.array(SyntheticTaskSchema),
});

export type TaskGenerationResponse = z.infer<typeof TaskGenerationResponseSchema>;

// ─── Phase 4: Empirical Testing ───────────────────────────

export interface TaskExecutionResult {
  taskId: string;
  taskType: 'bug' | 'feature';
  taskTitle: string;
  success: boolean;
  durationMs: number;
  durationApiMs: number;
  numTurns: number;
  totalCostUsd: number;
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  };
  filesRead: string[];
  filesModified: string[];
  stopReason: string;
  errors: string[];
}

// ─── Phase 5: Scoring ─────────────────────────────────────

export interface CategoryScore {
  name: string;
  score: number;
  weight: number;
  findings: string[];
  recommendations: string[];
}

export interface ExecutableRecommendation {
  id: string;
  title: string;
  priority: 1 | 2 | 3;
  estimatedScoreImpact: number;
  category: string;
  currentState: string;
  desiredEndState: string;
  filesToModify: { path: string; action: string }[];
  implementationSteps: string[];
  acceptanceCriteria: string[];
  context: string;
  draftContent?: string;
}

export interface HistoryEntry {
  timestamp: string;
  overallScore: number;
  grade: string;
  categoryScores: Record<string, number>;
  targetPath: string;
  costUsd: number;
}

export interface FinalReport {
  overallScore: number;
  grade: string;
  categories: CategoryScore[];
  staticAnalysis: StaticAnalysisResult;
  understanding: CodebaseUnderstanding | null;
  tasks: TaskGenerationResponse | null;
  taskResults: TaskExecutionResult[];
  recommendations: ExecutableRecommendation[];
  previousScore: number | null;
  totalCostUsd: number;
  totalDurationMs: number;
  generatedAt: string;
  targetPath: string;
}

// ─── Errors ───────────────────────────────────────────────

export class LlmSenseError extends Error {
  constructor(message: string, public code: string) {
    super(message);
    this.name = 'LlmSenseError';
  }
}

export class ClaudeCliError extends LlmSenseError {
  constructor(message: string, public stderr?: string) {
    super(message, 'CLAUDE_CLI_ERROR');
  }
}

export class IsolationError extends LlmSenseError {
  constructor(message: string) {
    super(message, 'ISOLATION_ERROR');
  }
}
