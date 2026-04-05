import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { get as httpsGet } from 'node:https';
import { get as httpGet } from 'node:http';

// ─── Types ────────────────────────────────────────────────

export interface ParsedFile {
  path: string;
  language: string;
  tree: TreeSitterTree;
}

// Minimal tree-sitter type definitions (avoids importing the full types)
export interface TreeSitterNode {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  childCount: number;
  children: TreeSitterNode[];
  namedChildCount: number;
  namedChildren: TreeSitterNode[];
  parent: TreeSitterNode | null;
  firstChild: TreeSitterNode | null;
  nextSibling: TreeSitterNode | null;
  descendantsOfType(type: string | string[]): TreeSitterNode[];
}

export interface TreeSitterTree {
  rootNode: TreeSitterNode;
}

// ─── Language → Grammar Mapping ───────────────────────────

interface GrammarInfo {
  npmPackage: string;
  wasmFile: string;
  version: string;
}

const GRAMMAR_MAP: Record<string, GrammarInfo> = {
  typescript: { npmPackage: 'tree-sitter-typescript', wasmFile: 'tree-sitter-typescript.wasm', version: '0.23.2' },
  tsx: { npmPackage: 'tree-sitter-typescript', wasmFile: 'tree-sitter-tsx.wasm', version: '0.23.2' },
  javascript: { npmPackage: 'tree-sitter-javascript', wasmFile: 'tree-sitter-javascript.wasm', version: '0.23.1' },
  python: { npmPackage: 'tree-sitter-python', wasmFile: 'tree-sitter-python.wasm', version: '0.23.6' },
  go: { npmPackage: 'tree-sitter-go', wasmFile: 'tree-sitter-go.wasm', version: '0.23.4' },
  rust: { npmPackage: 'tree-sitter-rust', wasmFile: 'tree-sitter-rust.wasm', version: '0.23.2' },
  java: { npmPackage: 'tree-sitter-java', wasmFile: 'tree-sitter-java.wasm', version: '0.23.5' },
  ruby: { npmPackage: 'tree-sitter-ruby', wasmFile: 'tree-sitter-ruby.wasm', version: '0.23.1' },
  php: { npmPackage: 'tree-sitter-php', wasmFile: 'tree-sitter-php.wasm', version: '0.23.11' },
};

const EXT_TO_LANGUAGE: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'tsx',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.py': 'python', '.pyx': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.rb': 'ruby',
  '.php': 'php',
};

export function getLanguageForExt(ext: string): string | null {
  return EXT_TO_LANGUAGE[ext] ?? null;
}

export function getSupportedExtensions(): string[] {
  return Object.keys(EXT_TO_LANGUAGE);
}

// ─── WASM Download + Caching ──────────────────────────────

const GRAMMAR_DIR = join(homedir(), '.llm-sense', 'grammars');
const CDN_BASE = 'https://cdn.jsdelivr.net/npm';

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

async function fileExists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

function downloadFile(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const handler = url.startsWith('https') ? httpsGet : httpGet;
    handler(url, { timeout: 30_000 }, (res) => {
      // Follow redirects
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        downloadFile(res.headers.location).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function downloadGrammar(language: string, verbose: boolean): Promise<string> {
  const info = GRAMMAR_MAP[language];
  if (!info) throw new Error(`No grammar available for language: ${language}`);

  await ensureDir(GRAMMAR_DIR);
  const localPath = join(GRAMMAR_DIR, info.wasmFile);

  if (await fileExists(localPath)) {
    return localPath;
  }

  const url = `${CDN_BASE}/${info.npmPackage}@${info.version}/${info.wasmFile}`;
  if (verbose) {
    process.stderr.write(`    Downloading grammar: ${language} from ${url}\n`);
  }

  try {
    const data = await downloadFile(url);
    await writeFile(localPath, data);
    return localPath;
  } catch (e) {
    throw new Error(`Failed to download ${language} grammar: ${e instanceof Error ? e.message : e}`);
  }
}

// ─── Parser Singleton ─────────────────────────────────────

let parserModule: typeof import('web-tree-sitter') | null = null;
let parserClass: any = null; // The Parser constructor
let languageClass: any = null; // The Language class
let initialized = false;
const loadedLanguages = new Map<string, any>(); // language name → Language instance

async function initParser(): Promise<void> {
  if (initialized) return;

  parserModule = await import('web-tree-sitter');
  parserClass = parserModule.Parser;
  languageClass = parserModule.Language;

  await parserClass.init();
  initialized = true;
}

async function getLanguage(language: string, verbose: boolean): Promise<any> {
  if (loadedLanguages.has(language)) return loadedLanguages.get(language)!;

  const wasmPath = await downloadGrammar(language, verbose);
  const wasmData = await readFile(wasmPath);
  const lang = await languageClass.load(wasmData);
  loadedLanguages.set(language, lang);
  return lang;
}

// ─── Public API ───────────────────────────────────────────

let initFailed = false;

export async function parseFileAST(
  filePath: string,
  content: string,
  language: string,
  verbose: boolean,
): Promise<TreeSitterTree | null> {
  if (initFailed) return null;

  try {
    await initParser();
    const lang = await getLanguage(language, verbose);
    const parser = new parserClass();
    parser.setLanguage(lang);
    const tree = parser.parse(content);
    return tree as TreeSitterTree;
  } catch (e) {
    if (verbose) {
      process.stderr.write(`    AST parse failed for ${filePath}: ${e instanceof Error ? e.message : e}\n`);
    }
    // If initialization itself failed, don't retry for every file
    if (!initialized) initFailed = true;
    return null;
  }
}

export async function isAstAvailable(): Promise<boolean> {
  if (initFailed) return false;
  try {
    await initParser();
    return true;
  } catch {
    initFailed = true;
    return false;
  }
}

// Pre-download grammars for all detected languages
export async function preloadGrammars(languages: string[], verbose: boolean): Promise<string[]> {
  const loaded: string[] = [];
  for (const lang of languages) {
    if (!GRAMMAR_MAP[lang]) continue;
    try {
      await getLanguage(lang, verbose);
      loaded.push(lang);
    } catch (e) {
      if (verbose) {
        process.stderr.write(`    Could not load ${lang} grammar: ${e instanceof Error ? e.message : e}\n`);
      }
    }
  }
  return loaded;
}

// ─── AST Walking Helpers ──────────────────────────────────

// Walk all nodes depth-first
export function walkTree(node: TreeSitterNode, callback: (node: TreeSitterNode, depth: number) => void, depth: number = 0): void {
  callback(node, depth);
  for (const child of node.children) {
    walkTree(child, callback, depth + 1);
  }
}

// Find all nodes matching a type
export function findNodes(root: TreeSitterNode, types: string[]): TreeSitterNode[] {
  const results: TreeSitterNode[] = [];
  walkTree(root, (node) => {
    if (types.includes(node.type)) {
      results.push(node);
    }
  });
  return results;
}

// ─── Language-Specific Node Types ─────────────────────────

export interface LanguageNodeTypes {
  functionTypes: string[];
  controlFlowTypes: string[];
  catchTypes: string[];
  logicalOperatorTypes: string[];
  loopTypes: string[];
  exportTypes: string[];
  callTypes: string[];
  typeAnnotationTypes: string[];
  commentTypes: string[];
}

const NODE_TYPES: Record<string, LanguageNodeTypes> = {
  typescript: {
    functionTypes: ['function_declaration', 'method_definition', 'arrow_function', 'function'],
    controlFlowTypes: ['if_statement', 'for_statement', 'for_in_statement', 'while_statement', 'do_statement', 'switch_case', 'ternary_expression'],
    catchTypes: ['catch_clause'],
    logicalOperatorTypes: ['binary_expression'], // check operator for && ||
    loopTypes: ['for_statement', 'for_in_statement', 'while_statement', 'do_statement'],
    exportTypes: ['export_statement'],
    callTypes: ['call_expression'],
    typeAnnotationTypes: ['type_annotation'],
    commentTypes: ['comment'],
  },
  tsx: {
    functionTypes: ['function_declaration', 'method_definition', 'arrow_function', 'function'],
    controlFlowTypes: ['if_statement', 'for_statement', 'for_in_statement', 'while_statement', 'do_statement', 'switch_case', 'ternary_expression'],
    catchTypes: ['catch_clause'],
    logicalOperatorTypes: ['binary_expression'],
    loopTypes: ['for_statement', 'for_in_statement', 'while_statement', 'do_statement'],
    exportTypes: ['export_statement'],
    callTypes: ['call_expression'],
    typeAnnotationTypes: ['type_annotation'],
    commentTypes: ['comment'],
  },
  javascript: {
    functionTypes: ['function_declaration', 'method_definition', 'arrow_function', 'function'],
    controlFlowTypes: ['if_statement', 'for_statement', 'for_in_statement', 'while_statement', 'do_statement', 'switch_case', 'ternary_expression'],
    catchTypes: ['catch_clause'],
    logicalOperatorTypes: ['binary_expression'],
    loopTypes: ['for_statement', 'for_in_statement', 'while_statement', 'do_statement'],
    exportTypes: ['export_statement'],
    callTypes: ['call_expression'],
    typeAnnotationTypes: [],
    commentTypes: ['comment'],
  },
  python: {
    functionTypes: ['function_definition'],
    controlFlowTypes: ['if_statement', 'elif_clause', 'for_statement', 'while_statement', 'conditional_expression'],
    catchTypes: ['except_clause'],
    logicalOperatorTypes: ['boolean_operator'],
    loopTypes: ['for_statement', 'while_statement'],
    exportTypes: [], // Python doesn't have explicit exports
    callTypes: ['call'],
    typeAnnotationTypes: ['type'],
    commentTypes: ['comment'],
  },
  go: {
    functionTypes: ['function_declaration', 'method_declaration', 'func_literal'],
    controlFlowTypes: ['if_statement', 'for_statement', 'select_statement', 'type_switch_statement', 'expression_case', 'default_case'],
    catchTypes: [], // Go uses error returns, not exceptions
    logicalOperatorTypes: ['binary_expression'],
    loopTypes: ['for_statement'],
    exportTypes: [], // Go uses capitalization for exports
    callTypes: ['call_expression'],
    typeAnnotationTypes: [],
    commentTypes: ['comment'],
  },
  rust: {
    functionTypes: ['function_item'],
    controlFlowTypes: ['if_expression', 'for_expression', 'while_expression', 'match_arm', 'if_let_expression'],
    catchTypes: [], // Rust uses Result/Option, not exceptions
    logicalOperatorTypes: ['binary_expression'],
    loopTypes: ['for_expression', 'while_expression', 'loop_expression'],
    exportTypes: ['use_declaration'],
    callTypes: ['call_expression'],
    typeAnnotationTypes: [],
    commentTypes: ['line_comment', 'block_comment'],
  },
  java: {
    functionTypes: ['method_declaration', 'constructor_declaration'],
    controlFlowTypes: ['if_statement', 'for_statement', 'enhanced_for_statement', 'while_statement', 'do_statement', 'switch_block_statement_group', 'ternary_expression'],
    catchTypes: ['catch_clause'],
    logicalOperatorTypes: ['binary_expression'],
    loopTypes: ['for_statement', 'enhanced_for_statement', 'while_statement', 'do_statement'],
    exportTypes: [], // Java uses classes/packages
    callTypes: ['method_invocation'],
    typeAnnotationTypes: [],
    commentTypes: ['line_comment', 'block_comment'],
  },
  ruby: {
    functionTypes: ['method', 'singleton_method'],
    controlFlowTypes: ['if', 'unless', 'case', 'when', 'while', 'until', 'for', 'ternary'],
    catchTypes: ['rescue'],
    logicalOperatorTypes: ['binary'],
    loopTypes: ['while', 'until', 'for'],
    exportTypes: [],
    callTypes: ['call', 'method_call'],
    typeAnnotationTypes: [],
    commentTypes: ['comment'],
  },
  php: {
    functionTypes: ['function_definition', 'method_declaration'],
    controlFlowTypes: ['if_statement', 'for_statement', 'foreach_statement', 'while_statement', 'do_statement', 'switch_statement', 'case_statement'],
    catchTypes: ['catch_clause'],
    logicalOperatorTypes: ['binary_expression'],
    loopTypes: ['for_statement', 'foreach_statement', 'while_statement', 'do_statement'],
    exportTypes: [],
    callTypes: ['function_call_expression', 'method_call_expression'],
    typeAnnotationTypes: ['union_type', 'named_type', 'primitive_type'],
    commentTypes: ['comment'],
  },
};

export function getNodeTypes(language: string): LanguageNodeTypes | null {
  return NODE_TYPES[language] ?? null;
}
