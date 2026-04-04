import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { runStaticAnalysis } from '../phases/staticAnalysis.js';
import { computeScores } from '../phases/scoring.js';
import { buildExecutableRecommendations } from '../report/recommendations.js';

// ─── MCP Protocol Types ──────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ─── Tool Definitions ────────────────────────────────────

const TOOLS = [
  {
    name: 'get_score',
    description: 'Returns current overall LLM-friendliness score with category breakdown',
    inputSchema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Path to analyze (default: current directory)' },
      },
    },
  },
  {
    name: 'get_recommendations',
    description: 'Returns top N actionable improvement recommendations',
    inputSchema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Path to analyze (default: current directory)' },
        count: { type: 'number', description: 'Number of recommendations to return (default: 5)' },
      },
    },
  },
  {
    name: 'check_file',
    description: 'Checks a single file for LLM-friendliness (size, naming, comments)',
    inputSchema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Path to the file to check' },
      },
      required: ['path'],
    },
  },
  {
    name: 'check_drift',
    description: 'Validates config file references — finds stale paths and commands',
    inputSchema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Path to analyze (default: current directory)' },
      },
    },
  },
  {
    name: 'get_heatmap',
    description: 'Returns token budget heatmap — shows which directories consume the most LLM context',
    inputSchema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Path to analyze (default: current directory)' },
      },
    },
  },
  {
    name: 'get_context_profile',
    description: 'Returns context window coverage at 32K/100K/200K/1M tiers — tells you which model tier your codebase needs',
    inputSchema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Path to analyze (default: current directory)' },
      },
    },
  },
  {
    name: 'get_language_checks',
    description: 'Returns language-specific code quality findings (type safety, error handling, conventions)',
    inputSchema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Path to analyze (default: current directory)' },
      },
    },
  },
  {
    name: 'auto_improve',
    description: 'Run auto-improve loop to reach a target score — applies fixes iteratively',
    inputSchema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Path to analyze and improve (default: current directory)' },
        target: { type: 'number', description: 'Target score to reach (required)' },
        maxIterations: { type: 'number', description: 'Max fix cycles (default: 5)' },
      },
      required: ['target'],
    },
  },
  {
    name: 'generate_config',
    description: 'Generate an AI config file (CLAUDE.md, .cursorrules, copilot-instructions.md, AGENTS.md) using Claude',
    inputSchema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Path to analyze (default: current directory)' },
        tool: { type: 'string', description: 'Which config to generate: claude-md, cursorrules, copilot, agents' },
      },
      required: ['tool'],
    },
  },
];

// ─── Tool Handlers ───────────────────────────────────────

async function runAnalysis(targetPath: string) {
  const resolvedPath = resolve(targetPath || '.');
  const { result: staticResult } = await runStaticAnalysis(resolvedPath, false);
  const { categories, overallScore, grade } = computeScores(staticResult, [], true);
  const recommendations = buildExecutableRecommendations(categories, staticResult, null);
  return { staticResult, categories, overallScore, grade, recommendations, targetPath: resolvedPath };
}

async function handleToolCall(name: string, args: Record<string, unknown>): Promise<unknown> {
  const targetPath = (args.path as string) || '.';

  switch (name) {
    case 'get_score': {
      const { categories, overallScore, grade, targetPath: resolved } = await runAnalysis(targetPath);
      return {
        score: overallScore,
        grade,
        target: resolved,
        categories: categories.map(c => ({
          name: c.name,
          score: c.score,
          weight: c.weight,
          weighted: Math.round(c.score * c.weight * 10) / 10,
        })),
      };
    }

    case 'get_recommendations': {
      const count = (args.count as number) || 5;
      const { recommendations } = await runAnalysis(targetPath);
      return {
        recommendations: recommendations.slice(0, count).map(r => ({
          id: r.id,
          title: r.title,
          priority: r.priority,
          estimatedScoreImpact: r.estimatedScoreImpact,
          estimatedEffort: r.estimatedEffort,
          category: r.category,
          currentState: r.currentState,
          desiredEndState: r.desiredEndState,
          implementationSteps: r.implementationSteps,
        })),
      };
    }

    case 'check_file': {
      const filePath = resolve(args.path as string);
      const { stat, readFile } = await import('node:fs/promises');
      const { extname, basename } = await import('node:path');

      try {
        const s = await stat(filePath);
        const content = await readFile(filePath, 'utf-8');
        const lines = content.split('\n');
        const ext = extname(filePath);
        const name = basename(filePath);

        // Comment ratio
        let commentLines = 0;
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
            commentLines++;
          }
        }

        const issues: string[] = [];
        if (lines.length > 1000) issues.push(`File is ${lines.length} lines — consider splitting into smaller modules`);
        else if (lines.length > 500) issues.push(`File is ${lines.length} lines — approaching recommended split threshold`);
        if (commentLines / lines.length < 0.03) issues.push('Very few inline comments — add comments for non-obvious logic');

        return {
          path: filePath,
          name,
          extension: ext,
          lines: lines.length,
          bytes: s.size,
          estimatedTokens: Math.round(s.size / 4),
          commentRatio: Math.round((commentLines / lines.length) * 1000) / 10 + '%',
          issues,
          verdict: issues.length === 0 ? 'good' : 'needs improvement',
        };
      } catch {
        return { error: `File not found: ${filePath}` };
      }
    }

    case 'check_drift': {
      const { staticResult, targetPath: resolved } = await runAnalysis(targetPath);
      const drift = staticResult.documentation.configDrift;
      return {
        target: resolved,
        freshnessScore: drift.freshnessScore,
        totalReferences: drift.totalReferences,
        validReferences: drift.validReferences,
        staleReferences: drift.staleReferences,
      };
    }

    case 'get_heatmap': {
      const { staticResult, targetPath: resolved } = await runAnalysis(targetPath);
      const heatmap = staticResult.tokenHeatmap;
      return {
        target: resolved,
        total: heatmap.total,
        totalFiles: heatmap.totalFiles,
        entries: heatmap.entries.slice(0, 20).map(e => ({
          path: e.path,
          tokens: e.tokens,
          percentage: e.percentage,
          isContextHog: e.isContextHog,
        })),
      };
    }

    case 'get_context_profile': {
      const { staticResult, targetPath: resolved } = await runAnalysis(targetPath);
      const profile = staticResult.contextProfile;
      if (!profile) return { error: 'Context profile not available' };
      return {
        target: resolved,
        totalSourceTokens: profile.totalSourceTokens,
        tiers: profile.tiers,
        recommendedMinimum: profile.recommendedMinimum,
        bestExperience: profile.bestExperience,
        topConsumers: profile.topConsumers,
      };
    }

    case 'get_language_checks': {
      const { staticResult, targetPath: resolved } = await runAnalysis(targetPath);
      const checks = staticResult.languageChecks ?? [];
      return {
        target: resolved,
        languages: checks.map(lc => ({
          language: lc.language,
          totalPenalty: lc.totalPenalty,
          filesScanned: lc.filesScanned,
          checks: lc.checks.filter(c => c.occurrences > 0),
          topFindings: lc.findings.slice(0, 10),
        })),
      };
    }

    case 'auto_improve': {
      const target = args.target as number;
      const maxIterations = (args.maxIterations as number) || 5;
      const resolvedPath = resolve(targetPath || '.');

      const { runAutoImprove } = await import('../phases/autoFix.js');
      const { result: staticResult } = await runStaticAnalysis(resolvedPath, false);
      const { overallScore } = computeScores(staticResult, [], true);

      const result = await runAutoImprove(
        {
          path: resolvedPath, bugs: 0, features: 0, output: '', maxBudgetPerTask: 1,
          maxTurnsPerTask: 30, skipEmpirical: true, verbose: false, history: false,
          format: 'json', fix: true, fixCount: 1, dryRun: false, fixContinue: true,
          yes: true, plan: false, interactive: false, monorepo: false, noMonorepo: false,
          noCache: false, prDelta: false, autoImprove: true, target, maxIterations,
          maxTotalBudget: 5.0,
        },
        overallScore,
        () => {}, // suppress logging
      );

      return result;
    }

    case 'generate_config': {
      const tool = args.tool as string;
      const resolvedPath = resolve(targetPath || '.');
      const { runInit } = await import('../commands/init.js');
      // For MCP, we just trigger init for a single tool
      // This is simplified — full implementation would generate just one file
      await runInit(resolvedPath, false, true);
      return { success: true, message: `Config files generated at ${resolvedPath}` };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ─── JSON-RPC Protocol Handler ───────────────────────────

function sendResponse(response: JsonRpcResponse): void {
  const json = JSON.stringify(response);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
}

function sendNotification(method: string, params?: unknown): void {
  const json = JSON.stringify({ jsonrpc: '2.0', method, params });
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
}

async function handleMessage(msg: JsonRpcRequest): Promise<void> {
  try {
    switch (msg.method) {
      case 'initialize': {
        sendResponse({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'llm-sense', version: '1.3.0' },
          },
        });
        break;
      }

      case 'notifications/initialized': {
        // Client acknowledged initialization — nothing to do
        break;
      }

      case 'tools/list': {
        sendResponse({
          jsonrpc: '2.0',
          id: msg.id,
          result: { tools: TOOLS },
        });
        break;
      }

      case 'tools/call': {
        const params = msg.params as { name: string; arguments?: Record<string, unknown> };
        try {
          const result = await handleToolCall(params.name, params.arguments ?? {});
          sendResponse({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            },
          });
        } catch (err) {
          sendResponse({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
              isError: true,
            },
          });
        }
        break;
      }

      case 'ping': {
        sendResponse({ jsonrpc: '2.0', id: msg.id, result: {} });
        break;
      }

      default: {
        // Unknown method — return method not found error
        if (msg.id !== undefined) {
          sendResponse({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32601, message: `Method not found: ${msg.method}` },
          });
        }
      }
    }
  } catch (err) {
    if (msg.id !== undefined) {
      sendResponse({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32603, message: err instanceof Error ? err.message : 'Internal error' },
      });
    }
  }
}

// ─── Stdio Transport ─────────────────────────────────────

export async function startMcpServer(): Promise<void> {
  // Read messages from stdin using Content-Length framing (LSP-style)
  let buffer = '';

  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk;

    // Process complete messages in the buffer
    while (true) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;

      const header = buffer.slice(0, headerEnd);
      const contentLengthMatch = header.match(/Content-Length:\s*(\d+)/i);
      if (!contentLengthMatch) {
        buffer = buffer.slice(headerEnd + 4);
        continue;
      }

      const contentLength = parseInt(contentLengthMatch[1], 10);
      const bodyStart = headerEnd + 4;

      if (buffer.length < bodyStart + contentLength) break; // Wait for more data

      const body = buffer.slice(bodyStart, bodyStart + contentLength);
      buffer = buffer.slice(bodyStart + contentLength);

      try {
        const msg = JSON.parse(body) as JsonRpcRequest;
        handleMessage(msg).catch(err => {
          process.stderr.write(`MCP handler error: ${err}\n`);
        });
      } catch {
        process.stderr.write(`Failed to parse JSON-RPC message\n`);
      }
    }
  });

  process.stdin.on('end', () => {
    process.exit(0);
  });

  // Keep the process alive
  process.stdin.resume();
}
