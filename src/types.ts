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
  concurrency?: number;
  format: 'markdown' | 'json' | 'summary' | 'html';
  minScore?: number;
  badge?: string;
  fix: boolean;
  fixCount: number;
  fixId?: string;
  dryRun: boolean;
  fixContinue: boolean;
  yes: boolean;
  plan: boolean; // deprecated — plan is now always included in the report
  compare?: string;
  interactive: boolean;
  monorepo: boolean;
  noMonorepo: boolean;
  noCache: boolean;
  // v1.1.0
  prDelta: boolean;
  // v1.2.0
  autoImprove: boolean;
  target?: number;
  maxIterations: number;
  maxTotalBudget: number;
  // v1.3.0
  profile?: string;
  // v2.0
  noAst: boolean;
  // v2.1
  gitHistory: boolean;
  annotations: boolean;
  generateIgnore: boolean;
  // v2.4
  noLlmLint: boolean;
  provider?: string;
}

// ─── Phase 1: Static Analysis ─────────────────────────────

export interface FileInfo {
  path: string;
  lines: number;
  bytes: number;
  classification?: 'code' | 'data' | 'vendored';
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
  codeFilesOver1000Lines: number; // excludes data/vendored files
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
  aiConfigScores: AiConfigScore[];
  configDrift: ConfigDriftResult;
  aiConfigCoverage: number;
  aiConfigConsistency: number;
}

export interface ImportsResult {
  avgImportsPerFile: number;
  maxImportsInFile: { path: string; count: number };
  circularDeps: string[][];
  externalDependencyCount: number;
  avgFanOut: number;
  avgFanIn: number;
  hubFiles: { path: string; fanIn: number }[];
  orphanFiles: string[];
  maxChainDepth: number;
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
  vendoredFileCount: number;
  sourceToNoiseRatio: number;
  totalFiles: number;
  sourceFiles: number;
}

export interface DevInfraResult {
  hasCi: boolean;
  hasTestCommand: boolean;
  hasLinterConfig: boolean;
  hasPreCommitHooks: boolean;
  hasTypeChecking: boolean;
  ciFiles: string[];
  // v2.0: expanded checks
  hasDevcontainer: boolean;
  devcontainerFeatures: string[];
  hasIssueTemplates: boolean;
  hasPrTemplate: boolean;
  hasContributing: boolean;
  hasChangelog: boolean;
  todoCount: number;
  hasStructuredLogging: boolean;
  hasEnvExample: boolean;
  hasHealthCheck: boolean;
  hasOpenTelemetry: boolean;
  score: number;
}

export interface AiConfigScore {
  file: string;
  exists: boolean;
  contentScore: number;
  lines: number;
  sectionScores?: Record<string, { found: boolean; score: number }>;
}

// ─── Config Drift Detection ──────────────────────────────

export interface StaleReference {
  file: string;
  line: number;
  reference: string;
  type: 'path' | 'command';
  reason: string;
}

export interface ConfigDriftResult {
  totalReferences: number;
  validReferences: number;
  staleReferences: StaleReference[];
  freshnessScore: number;
}

// ─── Token Budget Heatmap ────────────────────────────────

export interface TokenHeatmapEntry {
  path: string;
  tokens: number;
  percentage: number;
  isContextHog: boolean;
}

export interface TokenHeatmap {
  entries: TokenHeatmapEntry[];
  total: number;
  totalFiles: number;
}

// ─── Security Scoring ────────────────────────────────────

export interface SecurityFinding {
  check: string;
  severity: 'high' | 'medium' | 'low';
  detail: string;
  pointsDeducted: number;
}

export interface SecurityResult {
  score: number;
  findings: SecurityFinding[];
  hasGitignore: boolean;
  envExposed: boolean;
  hardcodedSecretFiles: string[];
  sensitiveFilesTracked: string[];
  missingLockfile: boolean;
}

export interface DuplicatePair {
  fileA: string;
  fileB: string;
  similarity: number;
  sharedExports: string[];
}

export interface DuplicatesResult {
  pairs: DuplicatePair[];
  totalFilesScanned: number;
}

// ─── AST Analysis (tree-sitter) ─────────────────────────

export interface FunctionMetrics {
  name: string;
  file: string;
  startLine: number;
  endLine: number;
  lineCount: number;
  cyclomaticComplexity: number;
  maxNestingDepth: number;
  hasTypeAnnotations: boolean;
  hasDocComment: boolean;
  parameterCount: number;
}

export interface StructuralDuplicate {
  functionA: { name: string; file: string; line: number };
  functionB: { name: string; file: string; line: number };
  lineCount: number;
  structuralHash: string;
}

export interface CallGraphResult {
  totalEdges: number;
  hotFunctions: Array<{ name: string; callCount: number }>;
  isolatedFunctions: string[];
  avgFanIn: number;
}

export interface ApiSurfaceResult {
  exportedSymbols: number;
  exportedFunctions: number;
  avgExportComplexity: number;
  complexExports: Array<{ name: string; file: string; complexity: number }>;
}

export interface FunctionScore {
  name: string;
  file: string;
  line: number;
  score: number;
  issues: string[];
}

export interface AstAnalysisResult {
  functions: FunctionMetrics[];
  avgComplexity: number;
  maxComplexity: FunctionMetrics | null;
  avgNestingDepth: number;
  maxNestingDepth: FunctionMetrics | null;
  avgFunctionLength: number;
  typeAnnotationCoverage: number;
  emptyCatchBlocks: number;
  magicNumbers: number;
  structuralDuplicates: StructuralDuplicate[];
  callGraph?: CallGraphResult;
  apiSurface?: ApiSurfaceResult;
  functionScores?: FunctionScore[];
  totalFilesAnalyzed: number;
  totalFunctionsAnalyzed: number;
}

export interface StaticAnalysisResult {
  fileSizes: FileSizeDistribution;
  directoryStructure: DirectoryStructureResult;
  naming: NamingResult;
  documentation: DocumentationResult;
  imports: ImportsResult;
  modularity: ModularityResult;
  noise: NoiseResult;
  devInfra: DevInfraResult;
  security: SecurityResult;
  tokenHeatmap: TokenHeatmap;
  duplicates: DuplicatesResult;
  fragmentationRatio: number;
  contextProfile?: ContextWindowProfile;
  languageChecks?: LanguageCheckResult[];
  astAnalysis?: AstAnalysisResult;
  gitHistory?: GitHistoryResult;
  // Import graph edges for dependency visualization (not serialized in JSON output)
  importGraph?: Array<{ source: string; target: string }>;
}

// ─── LLM Verification (Phase 2b) ─────────────────────────

export const LlmVerificationSchema = z.object({
  documentationQuality: z.object({
    score: z.number().min(1).max(10),
    reasoning: z.string(),
    isBoilerplate: z.boolean(),
  }),
  namingClarity: z.object({
    score: z.number().min(1).max(10),
    reasoning: z.string(),
    confusingNames: z.array(z.string()),
  }),
  architectureClarity: z.object({
    score: z.number().min(1).max(10),
    reasoning: z.string(),
    suggestions: z.array(z.string()),
  }),
});

export type LlmVerification = z.infer<typeof LlmVerificationSchema>;

export interface LlmVerificationAdjustments {
  documentation: number; // ±15
  naming: number;        // ±15
  coupling: number;      // ±15 (architecture clarity maps to coupling)
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
  fileOverlapScore: number;
  unexpectedFilesModified: string[];
  correctnessScore: number;
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
  estimatedEffort?: '5min' | '30min' | '2hr' | 'half-day';
  category: string;
  currentState: string;
  desiredEndState: string;
  filesToModify: { path: string; action: string }[];
  implementationSteps: string[];
  acceptanceCriteria: string[];
  context: string;
  draftContent?: string;
  dependsOn?: string[];
}

export interface HistoryEntry {
  timestamp: string;
  overallScore: number;
  grade: string;
  categoryScores: Record<string, number>;
  targetPath: string;
  costUsd: number;
  scoringVersion?: string;
  profile?: string;
  // v2.3: scoring consistency tracking
  mode?: 'static-only' | 'full';
  phase2Cached?: boolean; // true if Phase 2 results were loaded from cache
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
  tokenOptimization?: {
    excludeRecommendations: Array<{ path: string; tokens: number; reason: string; pattern: string }>;
    compressRecommendations: Array<{ path: string; tokens: number; estimatedCompressedTokens: number; reason: string; strategy: string }>;
    potentialSavings: { excludeTokens: number; compressTokens: number; totalTokens: number; savingsPercent: number };
  };
  llmLint?: {
    findings: Array<{
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
    }>;
    rulesEvaluated: number;
    candidatesEvaluated: number;
    filesScanned: number;
    totalCostUsd: number;
  };
}

// ─── Monorepo ────────────────────────────────────────────

export interface MonorepoPackage {
  name: string;
  path: string;
  relativePath: string;
  fileCount: number;
}

export interface MonorepoPackageResult {
  package: MonorepoPackage;
  score: number;
  grade: string;
  topIssue: string;
  categories: CategoryScore[];
}

export interface MonorepoResult {
  isMonorepo: boolean;
  packages: MonorepoPackage[];
  packageResults: MonorepoPackageResult[];
  aggregateScore: number;
  aggregateGrade: string;
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

// ─── v1.1.0: Per-PR Delta Prediction ────────────────────

export interface PrDeltaResult {
  predictedDelta: number;
  affectedCategories: Array<{
    name: string;
    previousScore: number;
    newScore: number;
    delta: number;
  }>;
  changedFiles: string[];
  analysisMode: 'selective' | 'full-fallback';
}

// ─── v1.2.0: Context Window Profiling ───────────────────

export interface ContextWindowTier {
  windowSize: number;
  label: string;
  coverage: number;
  verdict: 'Insufficient' | 'Partial' | 'Good' | 'Full';
}

export interface ContextWindowProfile {
  totalSourceTokens: number;
  tiers: ContextWindowTier[];
  recommendedMinimum: string;
  bestExperience: string;
  topConsumers: Array<{ path: string; percentage: number; tokens: number }>;
}

// ─── v1.2.0: Auto-Improve Loop ─────────────────────────

export interface AutoImproveResult {
  startScore: number;
  finalScore: number;
  targetScore: number;
  iterations: Array<{
    index: number;
    recommendation: string;
    delta: number;
    costUsd: number;
    success: boolean;
  }>;
  totalCostUsd: number;
  totalIterations: number;
  reachedTarget: boolean;
}

// ─── v1.2.0: AI-Generated Config (Zod schema) ──────────

export const ClaudeMdSectionsSchema = z.object({
  architectureOverview: z.string(),
  moduleMap: z.string(),
  commonPatterns: z.string(),
  testing: z.string(),
  buildRunDeploy: z.string(),
  gotchas: z.string(),
  techStack: z.string(),
  environmentSetup: z.string(),
});

export type ClaudeMdSections = z.infer<typeof ClaudeMdSectionsSchema>;

export const CursorRulesSectionsSchema = z.object({
  projectContext: z.string(),
  codingConventions: z.string(),
  importantFiles: z.string(),
  commands: z.string(),
  rules: z.string(),
});

export type CursorRulesSections = z.infer<typeof CursorRulesSectionsSchema>;

export const CopilotInstructionsSectionsSchema = z.object({
  projectOverview: z.string(),
  conventions: z.string(),
  commands: z.string(),
  architecture: z.string(),
});

export type CopilotInstructionsSections = z.infer<typeof CopilotInstructionsSectionsSchema>;

export const AgentsMdSectionsSchema = z.object({
  overview: z.string(),
  keyDirectories: z.string(),
  makingChanges: z.string(),
  testing: z.string(),
  commonPitfalls: z.string(),
});

export type AgentsMdSections = z.infer<typeof AgentsMdSectionsSchema>;

// ─── v1.3.0: Language-Specific Checks ───────────────────

export interface LanguageCheckFinding {
  check: string;
  language: string;
  file: string;
  line: number;
  penalty: number;
  message: string;
}

export interface LanguageCheckResult {
  language: string;
  checks: Array<{
    name: string;
    occurrences: number;
    penalty: number;
    cap: number;
  }>;
  totalPenalty: number;
  findings: LanguageCheckFinding[];
  filesScanned: number;
}

// ─── v1.3.0: Custom Scoring Profiles ────────────────────

export interface ScoringProfile {
  name: string;
  weights: Record<string, number>;
}

// ─── v2.1: Config Audit ─────────────────────────────────

export interface AuditDimensionScore {
  score: number;          // 0-100
  findings: string[];
}

export interface AuditConfigResult {
  file: string;
  filePath: string;
  formatId: string;
  exists: boolean;
  lines: number;
  overallScore: number;   // 0-100 aggregate
  dimensions: {
    completeness: AuditDimensionScore;
    accuracy: AuditDimensionScore;
    freshness: AuditDimensionScore;
    consistency: AuditDimensionScore;
    specificity: AuditDimensionScore;
  };
  recommendations: string[];
}

export interface AuditResult {
  configs: AuditConfigResult[];
  aggregateScore: number;
  grade: string;
  recommendations: string[];
  timestamp: string;
}

// ─── v2.1: Git History Analysis ─────────────────────────

export interface FileImportance {
  path: string;
  score: number;          // 0-100
  commitCount: number;
  lastModified: string;   // ISO date
  recencyScore: number;   // 0-1
  frequencyScore: number; // 0-1
}

export interface Hotspot {
  path: string;
  changeFrequency: number;
  complexity: number;
  risk: 'high' | 'medium' | 'low';
}

export interface KnowledgeConcentration {
  path: string;
  authors: number;
  totalCommits: number;
  dominantAuthor: string;
  dominantAuthorPct: number;
}

export interface GitHistoryResult {
  fileImportance: FileImportance[];
  hotspots: Hotspot[];
  knowledgeConcentration: KnowledgeConcentration[];
  conventionTrend: {
    direction: 'improving' | 'stable' | 'degrading';
    recentConsistency: number;
    olderConsistency: number;
  };
  churnComplexityCorrelation: Array<{
    path: string;
    churn: number;
    complexity: number;
  }>;
  totalCommitsAnalyzed: number;
  timespan: { oldest: string; newest: string };
}
