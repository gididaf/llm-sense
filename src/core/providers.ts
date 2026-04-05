import { z } from 'zod';
import { callClaudeStructured, isClaudeInstalled } from './claude.js';
import { spawn } from 'node:child_process';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { zodToJsonSchema } from 'zod-to-json-schema';

// ─── Provider Interface ──────────────────────────────────

export interface LlmProvider {
  name: string;
  /** Check if this provider is available (API key set, CLI installed, etc.) */
  isAvailable(): Promise<boolean>;
  /** Generate structured output matching a Zod schema */
  generateStructured<T>(
    prompt: string,
    schema: z.ZodType<T>,
    options?: { cwd?: string; timeout?: number },
  ): Promise<{ data: T; costUsd: number }>;
}

// ─── Claude Provider (default — uses Claude Code CLI) ────

export class ClaudeProvider implements LlmProvider {
  name = 'claude';

  async isAvailable(): Promise<boolean> {
    return isClaudeInstalled();
  }

  async generateStructured<T>(
    prompt: string,
    schema: z.ZodType<T>,
    options?: { cwd?: string; timeout?: number },
  ): Promise<{ data: T; costUsd: number }> {
    const { data, result } = await callClaudeStructured(
      { prompt, cwd: options?.cwd, timeout: options?.timeout ?? 120_000, tools: '', bare: false },
      schema,
    );
    return { data, costUsd: result.costUsd };
  }
}

// ─── OpenAI Provider (uses OPENAI_API_KEY env var) ───────

export class OpenAIProvider implements LlmProvider {
  name = 'openai';

  async isAvailable(): Promise<boolean> {
    return !!process.env.OPENAI_API_KEY;
  }

  async generateStructured<T>(
    prompt: string,
    schema: z.ZodType<T>,
    options?: { cwd?: string; timeout?: number },
  ): Promise<{ data: T; costUsd: number }> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY environment variable not set');

    const jsonSchema = zodToJsonSchema(schema);

    const body = JSON.stringify({
      model: process.env.OPENAI_MODEL ?? 'gpt-4o',
      messages: [
        { role: 'system', content: 'You are a helpful assistant that generates structured output. Respond with valid JSON matching the provided schema.' },
        { role: 'user', content: prompt },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'response',
          strict: true,
          schema: jsonSchema,
        },
      },
      temperature: 0.2,
    });

    const response = await fetchWithTimeout(
      'https://api.openai.com/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body,
      },
      options?.timeout ?? 120_000,
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OpenAI API error ${response.status}: ${text.slice(0, 300)}`);
    }

    const result = await response.json() as any;
    const content = result.choices?.[0]?.message?.content;
    if (!content) throw new Error('OpenAI returned no content');

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error(`Failed to parse OpenAI response as JSON: ${content.slice(0, 300)}`);
    }

    const validated = schema.safeParse(parsed);
    if (!validated.success) {
      throw new Error(`OpenAI response didn't match schema: ${validated.error.message}`);
    }

    // Approximate cost: GPT-4o is ~$2.50/1M input, $10/1M output
    const usage = result.usage ?? {};
    const costUsd = ((usage.prompt_tokens ?? 0) * 2.5 + (usage.completion_tokens ?? 0) * 10) / 1_000_000;

    return { data: validated.data, costUsd };
  }
}

// ─── Google Gemini Provider (uses GOOGLE_API_KEY env var) ─

export class GoogleProvider implements LlmProvider {
  name = 'google';

  async isAvailable(): Promise<boolean> {
    return !!process.env.GOOGLE_API_KEY;
  }

  async generateStructured<T>(
    prompt: string,
    schema: z.ZodType<T>,
    options?: { cwd?: string; timeout?: number },
  ): Promise<{ data: T; costUsd: number }> {
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) throw new Error('GOOGLE_API_KEY environment variable not set');

    const jsonSchema = zodToJsonSchema(schema);
    const model = process.env.GOOGLE_MODEL ?? 'gemini-2.0-flash';

    const body = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: jsonSchema,
        temperature: 0.2,
      },
    });

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    }, options?.timeout ?? 120_000);

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Google API error ${response.status}: ${text.slice(0, 300)}`);
    }

    const result = await response.json() as any;
    const content = result.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!content) throw new Error('Google API returned no content');

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error(`Failed to parse Google response as JSON: ${content.slice(0, 300)}`);
    }

    const validated = schema.safeParse(parsed);
    if (!validated.success) {
      throw new Error(`Google response didn't match schema: ${validated.error.message}`);
    }

    // Approximate cost: Gemini 2.0 Flash is ~$0.10/1M input, $0.40/1M output
    const usage = result.usageMetadata ?? {};
    const costUsd = ((usage.promptTokenCount ?? 0) * 0.1 + (usage.candidatesTokenCount ?? 0) * 0.4) / 1_000_000;

    return { data: validated.data, costUsd };
  }
}

// ─── Provider Resolution ─────────────────────────────────

const PROVIDERS: Record<string, () => LlmProvider> = {
  claude: () => new ClaudeProvider(),
  openai: () => new OpenAIProvider(),
  google: () => new GoogleProvider(),
};

/**
 * Resolve a provider by name with fallback chain:
 * specified provider → Claude CLI → null (template fallback)
 */
export async function resolveProvider(providerName?: string): Promise<LlmProvider | null> {
  // If explicitly specified, try that provider first
  if (providerName) {
    const factory = PROVIDERS[providerName];
    if (!factory) {
      throw new Error(`Unknown provider "${providerName}". Supported: ${Object.keys(PROVIDERS).join(', ')}`);
    }
    const provider = factory();
    if (await provider.isAvailable()) return provider;
    // Fall through to Claude CLI fallback
    console.error(`  Provider "${providerName}" not available, trying Claude CLI fallback...`);
  }

  // Fallback: try Claude CLI
  const claude = new ClaudeProvider();
  if (await claude.isAvailable()) return claude;

  // No provider available — caller should use template-based generation
  return null;
}

/** Get list of supported provider names */
export function getSupportedProviders(): string[] {
  return Object.keys(PROVIDERS);
}

// ─── Utility ─────────────────────────────────────────────

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
