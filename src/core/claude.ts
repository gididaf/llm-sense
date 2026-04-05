import { spawn, execFile } from 'node:child_process';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { ClaudeCliError } from '../types.js';

// `claude` may be a shell function (e.g., wrapping --dangerously-skip-permissions in sandboxed envs).
// We need the real binary path to spawn it directly via sh, so we use `command -v` which
// bypasses functions/aliases and returns the actual binary on disk.
let resolvedClaudePath: string | null = null;

async function getClaudeBinaryPath(): Promise<string> {
  if (resolvedClaudePath) return resolvedClaudePath;

  // Use the user's login shell to inherit PATH from their profile (.zshrc, .bashrc, etc.)
  const shell = process.env.SHELL || '/bin/zsh';

  return new Promise<string>((resolve, reject) => {
    const proc = spawn(shell, ['-lc', 'command -v claude'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.on('close', (code) => {
      const path = stdout.trim();
      if (code === 0 && path) {
        resolvedClaudePath = path;
        resolve(path);
      } else {
        reject(new ClaudeCliError('Claude Code CLI not found. Install it from https://claude.ai/code'));
      }
    });
    proc.on('error', () => {
      reject(new ClaudeCliError('Claude Code CLI not found. Install it from https://claude.ai/code'));
    });
  });
}

export async function isClaudeInstalled(): Promise<boolean> {
  try {
    await getClaudeBinaryPath();
    return true;
  } catch {
    return false;
  }
}

interface ClaudeOptions {
  prompt: string;
  cwd?: string;
  timeout?: number;
  model?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  tools?: string;
  bare?: boolean;
}

export interface ClaudeResult {
  text: string;
  costUsd: number;
  durationMs: number;
  durationApiMs: number;
  numTurns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  isError: boolean;
  subtype: string;
  stopReason: string;
}

// Fallback JSON extraction for when Claude wraps JSON in markdown fences or prose.
// Used by callClaudeJSON when direct JSON.parse fails.
function extractJSON(text: string): string {
  // Try markdown fence first (```json ... ```)
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) return fenceMatch[1].trim();

  // Fall back to finding the outermost { ... } pair
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return text.slice(firstBrace, lastBrace + 1);
  }

  return text.trim();
}

function buildCommand(tmpFile: string, claudeBin: string, options: ClaudeOptions): string {
  let cmd = `cat "${tmpFile}" | "${claudeBin}" -p - --output-format json --dangerously-skip-permissions`;

  if (options.model) cmd += ` --model ${options.model}`;
  if (options.maxTurns) cmd += ` --max-turns ${options.maxTurns}`;
  if (options.maxBudgetUsd) cmd += ` --max-budget-usd ${options.maxBudgetUsd}`;
  if (options.tools !== undefined) cmd += ` --tools "${options.tools}"`;
  if (options.bare) cmd += ` --bare`;

  return cmd;
}

function parseClaudeOutput(stdout: string, durationMs: number): ClaudeResult {
  const json = JSON.parse(stdout);
  return {
    text: typeof json.result === 'string' ? json.result : JSON.stringify(json.result ?? ''),
    costUsd: json.total_cost_usd ?? json.cost_usd ?? 0,
    durationMs,
    durationApiMs: json.duration_api_ms ?? 0,
    numTurns: json.num_turns ?? 0,
    inputTokens: json.usage?.input_tokens ?? 0,
    outputTokens: json.usage?.output_tokens ?? 0,
    cacheReadTokens: json.usage?.cache_read_input_tokens ?? 0,
    cacheCreationTokens: json.usage?.cache_creation_input_tokens ?? 0,
    isError: json.is_error ?? false,
    subtype: json.subtype ?? '',
    stopReason: json.stop_reason ?? '',
  };
}

export async function callClaude(options: ClaudeOptions): Promise<ClaudeResult> {
  const { prompt, cwd, timeout = 300_000 } = options;
  const startTime = Date.now();
  const claudeBin = await getClaudeBinaryPath();

  // Write prompt to a temp file and pipe via `cat` to avoid shell escaping issues
  // with complex prompts that contain quotes, backticks, or special characters.
  const tmpFile = join(tmpdir(), `llm-sense-prompt-${randomBytes(8).toString('hex')}.txt`);
  await writeFile(tmpFile, prompt, 'utf-8');

  try {
    return await new Promise<ClaudeResult>((resolve, reject) => {
      const shellCmd = buildCommand(tmpFile, claudeBin, options);

      // Spawn via sh — we already resolved the full binary path so no login shell needed
      const proc = spawn('sh', ['-c', shellCmd], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      const timer = setTimeout(() => {
        proc.kill('SIGTERM');
        // SIGTERM may not reliably kill Claude Code — escalate to SIGKILL after 5s grace
        const killTimer = setTimeout(() => { proc.kill('SIGKILL'); }, 5000);
        proc.on('close', () => clearTimeout(killTimer));
        reject(new ClaudeCliError('Claude Code CLI timed out after ' + (timeout / 1000) + 's', stderr));
      }, timeout);

      proc.on('error', (error: any) => {
        clearTimeout(timer);
        if (error.code === 'ENOENT') {
          reject(new ClaudeCliError(
            'Claude Code CLI not found. Install it from https://claude.ai/code',
            stderr,
          ));
          return;
        }
        reject(new ClaudeCliError(`Claude Code CLI failed: ${error.message}`, stderr));
      });

      proc.on('close', (code: number | null) => {
        clearTimeout(timer);
        const durationMs = Date.now() - startTime;

        if (code !== 0) {
          reject(new ClaudeCliError(
            `Claude Code CLI exited with code ${code}`,
            stderr.slice(0, 500),
          ));
          return;
        }

        try {
          const result = parseClaudeOutput(stdout, durationMs);
          // Check for in-band errors (e.g., "Not logged in")
          if (result.isError) {
            reject(new ClaudeCliError(
              `Claude Code CLI error: ${result.text.slice(0, 200)}`,
              stderr,
            ));
            return;
          }
          resolve(result);
        } catch {
          resolve({
            text: stdout,
            costUsd: 0,
            durationMs,
            durationApiMs: 0,
            numTurns: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            isError: false,
            subtype: '',
            stopReason: '',
          });
        }
      });
    });
  } finally {
    try { await unlink(tmpFile); } catch {}
  }
}

export async function callClaudeJSON<T>(
  options: ClaudeOptions,
  schema: z.ZodType<T>,
): Promise<{ data: T; result: ClaudeResult }> {
  const result = await callClaude(options);

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.text);
  } catch {
    const extracted = extractJSON(result.text);
    try {
      parsed = JSON.parse(extracted);
    } catch {
      throw new ClaudeCliError(
        `Failed to parse Claude response as JSON.\nRaw response:\n${result.text.slice(0, 500)}`,
      );
    }
  }

  const validated = schema.safeParse(parsed);
  if (!validated.success) {
    throw new ClaudeCliError(
      `Claude response didn't match expected schema: ${validated.error.message}\nParsed: ${JSON.stringify(parsed).slice(0, 500)}`,
    );
  }

  return { data: validated.data, result };
}

// Uses Claude CLI's --json-schema flag for guaranteed structured output.
// The CLI validates the response against the schema before returning, so we get
// type-safe data without relying on prompt-based JSON generation.
export async function callClaudeStructured<T>(
  options: ClaudeOptions,
  schema: z.ZodType<T>,
): Promise<{ data: T; result: ClaudeResult }> {
  // Convert Zod schema → JSON Schema for the --json-schema CLI flag
  const jsonSchema = zodToJsonSchema(schema);
  const { prompt, cwd, timeout = 300_000 } = options;
  const startTime = Date.now();
  const claudeBin = await getClaudeBinaryPath();

  const tmpFile = join(tmpdir(), `llm-sense-prompt-${randomBytes(8).toString('hex')}.txt`);
  await writeFile(tmpFile, prompt, 'utf-8');

  const schemaFile = join(tmpdir(), `llm-sense-schema-${randomBytes(8).toString('hex')}.json`);
  await writeFile(schemaFile, JSON.stringify(jsonSchema), 'utf-8');

  try {
    return await new Promise<{ data: T; result: ClaudeResult }>((resolve, reject) => {
      let cmd = `cat "${tmpFile}" | "${claudeBin}" -p - --output-format json --dangerously-skip-permissions`;
      cmd += ` --json-schema "$(cat '${schemaFile}')"`;
      if (options.model) cmd += ` --model ${options.model}`;
      if (options.tools !== undefined) cmd += ` --tools "${options.tools}"`;
      if (options.bare) cmd += ` --bare`;

      const proc = spawn('sh', ['-c', cmd], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
      proc.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

      const timer = setTimeout(() => {
        proc.kill('SIGTERM');
        reject(new ClaudeCliError('Claude Code CLI timed out', stderr));
      }, timeout);

      proc.on('error', (error: any) => {
        clearTimeout(timer);
        reject(new ClaudeCliError(`Claude Code CLI failed: ${error.message}`, stderr));
      });

      proc.on('close', (code: number | null) => {
        clearTimeout(timer);
        const durationMs = Date.now() - startTime;

        if (code !== 0) {
          reject(new ClaudeCliError(`Claude Code CLI exited with code ${code}`, stderr.slice(0, 500)));
          return;
        }

        try {
          const json = JSON.parse(stdout);
          const resultObj = parseClaudeOutput(stdout, durationMs);

          // --json-schema puts validated output in structured_output or result
          const structuredData = json.structured_output ?? json.result;
          let parsed: unknown;
          if (typeof structuredData === 'string') {
            try { parsed = JSON.parse(structuredData); } catch { parsed = structuredData; }
          } else {
            parsed = structuredData;
          }

          const validated = schema.safeParse(parsed);
          if (!validated.success) {
            reject(new ClaudeCliError(
              `Structured output didn't match schema: ${validated.error.message}\nData: ${JSON.stringify(parsed).slice(0, 500)}`,
            ));
            return;
          }

          resolve({ data: validated.data, result: resultObj });
        } catch (e) {
          reject(new ClaudeCliError(`Failed to parse Claude output: ${e}`, stderr));
        }
      });
    });
  } finally {
    try { await unlink(tmpFile); } catch {}
    try { await unlink(schemaFile); } catch {}
  }
}

// Retry wrapper for transient Claude API failures (timeouts, rate limits, overload).
// Non-transient errors (auth failures, schema mismatches) are thrown immediately.
export async function callClaudeWithRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 2,
  backoffMs: number = 5000,
): Promise<T> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      if (attempt < maxRetries) {
        // Only retry on transient errors — permanent failures should fail fast
        const isTransient = error instanceof ClaudeCliError &&
          (error.message.includes('timed out') || error.message.includes('429') || error.message.includes('overloaded'));
        if (isTransient) {
          await new Promise(r => setTimeout(r, backoffMs * (attempt + 1)));
          continue;
        }
      }
      throw error;
    }
  }
  throw lastError;
}
