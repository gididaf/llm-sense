import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import type { WalkEntry } from '../core/fs.js';
import {
  parseFileAST, getLanguageForExt, getNodeTypes, isAstAvailable, preloadGrammars,
  walkTree, findNodes, getSupportedExtensions,
  type TreeSitterNode, type TreeSitterTree,
} from '../core/ast.js';
import type {
  AstAnalysisResult, FunctionMetrics, StructuralDuplicate,
  CallGraphResult, ApiSurfaceResult, FunctionScore,
} from '../types.js';

// ─── Phase 3b: Function-Level Metrics ─────────────────────

function getFunctionName(node: TreeSitterNode, language: string): string {
  // Try to extract function name from different node structures
  for (const child of node.namedChildren) {
    if (child.type === 'identifier' || child.type === 'property_identifier' || child.type === 'name') {
      return child.text;
    }
  }
  // Arrow functions assigned to variables: const foo = () => ...
  if (node.parent?.type === 'variable_declarator') {
    const name = node.parent.namedChildren.find(c => c.type === 'identifier');
    if (name) return name.text;
  }
  // Method definitions
  if (node.parent?.type === 'pair' || node.parent?.type === 'method_definition') {
    const name = node.parent.namedChildren.find(c => c.type === 'property_identifier' || c.type === 'identifier');
    if (name) return name.text;
  }
  return '<anonymous>';
}

function computeCyclomaticComplexity(funcNode: TreeSitterNode, language: string): number {
  const types = getNodeTypes(language);
  if (!types) return 1;

  let complexity = 1; // base

  walkTree(funcNode, (node) => {
    if (types.controlFlowTypes.includes(node.type)) {
      complexity++;
    }
    // Logical operators (&& ||) add decision points
    if (types.logicalOperatorTypes.includes(node.type)) {
      const op = node.children.find(c => c.type === '&&' || c.type === '||' ||
        c.text === 'and' || c.text === 'or');
      if (op) complexity++;
    }
  });

  return complexity;
}

function computeMaxNestingDepth(funcNode: TreeSitterNode, language: string): number {
  const types = getNodeTypes(language);
  if (!types) return 0;

  const nestingTypes = new Set([...types.controlFlowTypes, ...types.loopTypes, ...types.catchTypes]);
  let maxDepth = 0;

  function walk(node: TreeSitterNode, depth: number): void {
    if (nestingTypes.has(node.type)) {
      depth++;
      if (depth > maxDepth) maxDepth = depth;
    }
    for (const child of node.children) {
      walk(child, depth);
    }
  }

  walk(funcNode, 0);
  return maxDepth;
}

function hasDocComment(funcNode: TreeSitterNode): boolean {
  // Check the previous sibling for a comment
  let prev = funcNode.parent?.children
    ? funcNode.parent.children[funcNode.parent.children.indexOf(funcNode) - 1]
    : null;

  // Walk up: the function might be inside an export statement
  if (!prev && funcNode.parent) {
    const grandparent = funcNode.parent.parent;
    if (grandparent) {
      const parentIdx = grandparent.children.indexOf(funcNode.parent);
      if (parentIdx > 0) {
        prev = grandparent.children[parentIdx - 1];
      }
    }
  }

  if (prev && prev.type === 'comment') {
    const text = prev.text;
    return text.startsWith('/**') || text.startsWith('///') || text.startsWith('#') ||
      text.includes('@param') || text.includes('@returns') || text.includes('"""') ||
      text.startsWith('//!');
  }
  return false;
}

function hasTypeAnnotations(funcNode: TreeSitterNode, language: string): boolean {
  const types = getNodeTypes(language);
  if (!types || types.typeAnnotationTypes.length === 0) return true; // Languages without annotations get a pass

  const annotations = findNodes(funcNode, types.typeAnnotationTypes);
  // Check if return type and at least one param have annotations
  return annotations.length > 0;
}

function countParameters(funcNode: TreeSitterNode): number {
  const params = funcNode.namedChildren.find(c =>
    c.type === 'formal_parameters' || c.type === 'parameters' ||
    c.type === 'parameter_list' || c.type === 'method_parameters');
  if (!params) return 0;
  return params.namedChildren.filter(c =>
    c.type !== 'comment' && c.type !== ',').length;
}

function extractFunctionMetrics(
  funcNode: TreeSitterNode,
  filePath: string,
  language: string,
): FunctionMetrics {
  const name = getFunctionName(funcNode, language);
  const startLine = funcNode.startPosition.row + 1;
  const endLine = funcNode.endPosition.row + 1;
  const lineCount = endLine - startLine + 1;

  return {
    name,
    file: filePath,
    startLine,
    endLine,
    lineCount,
    cyclomaticComplexity: computeCyclomaticComplexity(funcNode, language),
    maxNestingDepth: computeMaxNestingDepth(funcNode, language),
    hasTypeAnnotations: hasTypeAnnotations(funcNode, language),
    hasDocComment: hasDocComment(funcNode),
    parameterCount: countParameters(funcNode),
  };
}

// ─── Phase 3b: Empty Catch Blocks ─────────────────────────

function countEmptyCatchBlocks(tree: TreeSitterTree, language: string): number {
  const types = getNodeTypes(language);
  if (!types || types.catchTypes.length === 0) return 0;

  const catches = findNodes(tree.rootNode, types.catchTypes);
  let empty = 0;
  for (const c of catches) {
    const body = c.namedChildren.find(n =>
      n.type === 'statement_block' || n.type === 'block' || n.type === 'body');
    if (body && body.namedChildCount === 0) empty++;
    // Also count single-comment catch blocks as "empty"
    if (body && body.namedChildCount === 1 && body.namedChildren[0].type === 'comment') empty++;
  }
  return empty;
}

// ─── Phase 3b: Magic Numbers ──────────────────────────────

function countMagicNumbers(tree: TreeSitterTree): number {
  const allowed = new Set(['0', '1', '-1', '2', '100', '1000', '0.0', '1.0']);
  let count = 0;

  walkTree(tree.rootNode, (node) => {
    if (node.type === 'number' || node.type === 'integer' || node.type === 'float') {
      const val = node.text;
      if (!allowed.has(val)) {
        // Skip if inside a constant declaration or enum
        let parent = node.parent;
        let isConst = false;
        while (parent) {
          if (parent.type === 'lexical_declaration' || parent.type === 'const_declaration' ||
              parent.type === 'enum_declaration' || parent.type === 'const_item' ||
              parent.type === 'assignment' && parent.text.includes('const')) {
            isConst = true;
            break;
          }
          parent = parent.parent;
        }
        if (!isConst) count++;
      }
    }
  });

  return count;
}

// ─── Phase 3c: Structural Duplicate Detection ─────────────

function hashAstStructure(node: TreeSitterNode, depth: number = 0): string {
  if (depth > 20) return '...'; // prevent infinite recursion

  // Normalize: use node type but replace identifiers with placeholder
  const isIdentifier = node.type === 'identifier' || node.type === 'property_identifier' ||
    node.type === 'name' || node.type === 'variable_name';
  const nodeRepr = isIdentifier ? '$ID' : node.type;

  if (node.childCount === 0) {
    // Leaf node: normalize identifiers and string literals
    if (isIdentifier) return '$ID';
    if (node.type === 'string' || node.type === 'string_literal') return '$STR';
    if (node.type === 'number' || node.type === 'integer' || node.type === 'float') return '$NUM';
    return nodeRepr;
  }

  const childHashes = node.children
    .filter(c => c.type !== 'comment') // ignore comments
    .map(c => hashAstStructure(c, depth + 1));

  return `(${nodeRepr} ${childHashes.join(' ')})`;
}

function findStructuralDuplicates(
  allFunctions: Array<{ metrics: FunctionMetrics; node: TreeSitterNode; hash?: string }>,
): StructuralDuplicate[] {
  // Only compare functions with >= 5 lines (ignore trivial functions)
  const significant = allFunctions.filter(f => f.metrics.lineCount >= 5);

  // Hash each function's body structure
  for (const f of significant) {
    const body = f.node.namedChildren.find(c =>
      c.type === 'statement_block' || c.type === 'block' || c.type === 'body' ||
      c.type === 'function_body');
    f.hash = body ? hashAstStructure(body) : hashAstStructure(f.node);
  }

  // Group by hash
  const groups = new Map<string, typeof significant>();
  for (const f of significant) {
    if (!f.hash) continue;
    const group = groups.get(f.hash) ?? [];
    group.push(f);
    groups.set(f.hash, group);
  }

  // Extract duplicates (groups with 2+ functions from different files)
  const duplicates: StructuralDuplicate[] = [];
  for (const [hash, group] of groups) {
    if (group.length < 2) continue;

    // De-duplicate within the same file (overloads are OK)
    const byFile = new Map<string, typeof group[0]>();
    for (const f of group) {
      if (!byFile.has(f.metrics.file)) byFile.set(f.metrics.file, f);
    }
    if (byFile.size < 2) continue;

    const entries = [...byFile.values()];
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        duplicates.push({
          functionA: { name: entries[i].metrics.name, file: entries[i].metrics.file, line: entries[i].metrics.startLine },
          functionB: { name: entries[j].metrics.name, file: entries[j].metrics.file, line: entries[j].metrics.startLine },
          lineCount: entries[i].metrics.lineCount,
          structuralHash: hash.slice(0, 40),
        });
      }
    }
  }

  return duplicates.slice(0, 50); // cap to avoid noise
}

// ─── Phase 3d: Call Graph ─────────────────────────────────

function buildCallGraph(
  allFunctions: Array<{ metrics: FunctionMetrics; node: TreeSitterNode }>,
  trees: Array<{ tree: TreeSitterTree; language: string; path: string }>,
): CallGraphResult {
  const functionNames = new Set(allFunctions.map(f => f.metrics.name).filter(n => n !== '<anonymous>'));
  const edges: Array<{ caller: string; callee: string; file: string }> = [];
  const callCounts = new Map<string, number>();

  for (const { tree, language, path } of trees) {
    const types = getNodeTypes(language);
    if (!types) continue;

    const calls = findNodes(tree.rootNode, types.callTypes);
    for (const call of calls) {
      // Extract callee name
      const callee = call.namedChildren[0];
      if (!callee) continue;
      const calleeName = callee.type === 'identifier' ? callee.text :
        callee.type === 'member_expression' || callee.type === 'attribute' ?
          (callee.namedChildren[callee.namedChildCount - 1]?.text ?? callee.text) :
          null;

      if (calleeName && functionNames.has(calleeName)) {
        // Find the enclosing function
        let parent = call.parent;
        let callerName = '<module>';
        while (parent) {
          const types2 = getNodeTypes(language);
          if (types2 && types2.functionTypes.includes(parent.type)) {
            callerName = getFunctionName(parent, language);
            break;
          }
          parent = parent.parent;
        }

        edges.push({ caller: callerName, callee: calleeName, file: path });
        callCounts.set(calleeName, (callCounts.get(calleeName) ?? 0) + 1);
      }
    }
  }

  // Find most-called functions (high fan-in = important)
  const hotFunctions = [...callCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, count]) => ({ name, callCount: count }));

  // Find isolated functions (defined but never called internally)
  const calledNames = new Set(edges.map(e => e.callee));
  const isolatedFunctions = allFunctions
    .filter(f => f.metrics.name !== '<anonymous>' && !calledNames.has(f.metrics.name))
    .map(f => f.metrics.name)
    .slice(0, 20);

  return {
    totalEdges: edges.length,
    hotFunctions,
    isolatedFunctions,
    avgFanIn: functionNames.size > 0 ? edges.length / functionNames.size : 0,
  };
}

// ─── Phase 3d: API Surface ────────────────────────────────

function measureApiSurface(
  trees: Array<{ tree: TreeSitterTree; language: string; path: string }>,
  allFunctions: Array<{ metrics: FunctionMetrics; node: TreeSitterNode }>,
): ApiSurfaceResult {
  let exportedSymbols = 0;
  let exportedFunctions = 0;
  let totalComplexity = 0;
  const complexExports: Array<{ name: string; file: string; complexity: number }> = [];

  for (const { tree, language, path } of trees) {
    const types = getNodeTypes(language);
    if (!types || types.exportTypes.length === 0) continue;

    const exports = findNodes(tree.rootNode, types.exportTypes);
    for (const exp of exports) {
      exportedSymbols++;

      // Find functions within exports
      const funcsInExport = findNodes(exp, types.functionTypes);
      for (const func of funcsInExport) {
        exportedFunctions++;
        const cc = computeCyclomaticComplexity(func, language);
        totalComplexity += cc;
        if (cc >= 5) {
          const name = getFunctionName(func, language);
          complexExports.push({ name, file: path, complexity: cc });
        }
      }
    }

    // Go: exported = capitalized first letter
    if (language === 'go') {
      const funcs = allFunctions.filter(f => f.metrics.file === path && /^[A-Z]/.test(f.metrics.name));
      for (const f of funcs) {
        exportedSymbols++;
        exportedFunctions++;
        totalComplexity += f.metrics.cyclomaticComplexity;
        if (f.metrics.cyclomaticComplexity >= 5) {
          complexExports.push({ name: f.metrics.name, file: path, complexity: f.metrics.cyclomaticComplexity });
        }
      }
    }
  }

  complexExports.sort((a, b) => b.complexity - a.complexity);

  return {
    exportedSymbols,
    exportedFunctions,
    avgExportComplexity: exportedFunctions > 0 ? totalComplexity / exportedFunctions : 0,
    complexExports: complexExports.slice(0, 10),
  };
}

// ─── Phase 3d: Per-Function LLM-Friendliness Score ────────

function scoreFunctions(
  allFunctions: Array<{ metrics: FunctionMetrics }>,
): FunctionScore[] {
  return allFunctions.map(({ metrics }) => {
    let score = 100;

    // Complexity penalty: -5 per point above 5
    if (metrics.cyclomaticComplexity > 5) {
      score -= Math.min((metrics.cyclomaticComplexity - 5) * 5, 30);
    }

    // Nesting depth penalty: -10 per level above 3
    if (metrics.maxNestingDepth > 3) {
      score -= Math.min((metrics.maxNestingDepth - 3) * 10, 30);
    }

    // Length penalty: -2 per line above 30
    if (metrics.lineCount > 30) {
      score -= Math.min((metrics.lineCount - 30) * 2, 30);
    }

    // Type annotation bonus
    if (metrics.hasTypeAnnotations) score += 5;

    // Doc comment bonus
    if (metrics.hasDocComment) score += 5;

    // Too many parameters penalty
    if (metrics.parameterCount > 5) {
      score -= Math.min((metrics.parameterCount - 5) * 3, 15);
    }

    score = Math.max(0, Math.min(100, score));

    return {
      name: metrics.name,
      file: metrics.file,
      line: metrics.startLine,
      score,
      issues: buildIssueList(metrics),
    };
  });
}

function buildIssueList(m: FunctionMetrics): string[] {
  const issues: string[] = [];
  if (m.cyclomaticComplexity > 10) issues.push(`High complexity (${m.cyclomaticComplexity})`);
  else if (m.cyclomaticComplexity > 5) issues.push(`Moderate complexity (${m.cyclomaticComplexity})`);
  if (m.maxNestingDepth > 4) issues.push(`Deep nesting (${m.maxNestingDepth} levels)`);
  if (m.lineCount > 50) issues.push(`Long function (${m.lineCount} lines)`);
  if (m.parameterCount > 5) issues.push(`Many parameters (${m.parameterCount})`);
  if (!m.hasDocComment) issues.push('Missing doc comment');
  if (!m.hasTypeAnnotations) issues.push('Missing type annotations');
  return issues;
}

// ─── Main Entry Point ─────────────────────────────────────

export async function analyzeWithAst(
  entries: WalkEntry[],
  verbose: boolean,
): Promise<AstAnalysisResult | null> {
  if (!(await isAstAvailable())) return null;

  const supportedExts = new Set(getSupportedExtensions());
  const sourceFiles = entries.filter(e =>
    e.isFile && supportedExts.has(extname(e.name)));

  if (sourceFiles.length === 0) return null;

  // Detect which languages are needed
  const neededLanguages = new Set<string>();
  for (const f of sourceFiles) {
    const lang = getLanguageForExt(extname(f.name));
    if (lang) neededLanguages.add(lang);
  }

  // Preload grammars
  const loaded = await preloadGrammars([...neededLanguages], verbose);
  if (loaded.length === 0) return null;

  const loadedSet = new Set(loaded);
  if (verbose) {
    process.stderr.write(`    AST grammars loaded: ${loaded.join(', ')}\n`);
  }

  // Sample files for large repos (AST parsing is heavier than regex)
  const maxFiles = 500;
  const filesToAnalyze = sourceFiles.length > maxFiles
    ? sampleFiles(sourceFiles, maxFiles)
    : sourceFiles;

  // Parse files and collect metrics
  const allFunctions: Array<{ metrics: FunctionMetrics; node: TreeSitterNode }> = [];
  const trees: Array<{ tree: TreeSitterTree; language: string; path: string }> = [];
  let emptyCatches = 0;
  let magicNumbers = 0;
  let totalFilesAnalyzed = 0;

  for (const entry of filesToAnalyze) {
    const ext = extname(entry.name);
    const language = getLanguageForExt(ext);
    if (!language || !loadedSet.has(language)) continue;

    try {
      const content = await readFile(entry.path, 'utf-8');
      if (content.length > 500_000) continue; // skip very large files

      const tree = await parseFileAST(entry.path, content, language, verbose);
      if (!tree) continue;

      totalFilesAnalyzed++;
      trees.push({ tree, language, path: entry.relativePath });

      // Extract functions
      const types = getNodeTypes(language);
      if (types) {
        const funcNodes = findNodes(tree.rootNode, types.functionTypes);
        for (const func of funcNodes) {
          // Skip nested functions (only top-level and class methods)
          let isNested = false;
          let parent = func.parent;
          while (parent) {
            if (types.functionTypes.includes(parent.type)) {
              isNested = true;
              break;
            }
            parent = parent.parent;
          }
          if (isNested) continue;

          const metrics = extractFunctionMetrics(func, entry.relativePath, language);
          allFunctions.push({ metrics, node: func });
        }

        emptyCatches += countEmptyCatchBlocks(tree, language);
      }

      magicNumbers += countMagicNumbers(tree);
    } catch {
      // Skip files that fail to parse
    }
  }

  if (allFunctions.length === 0) return null;

  // Phase 3b: Aggregate metrics
  const complexities = allFunctions.map(f => f.metrics.cyclomaticComplexity);
  const nestingDepths = allFunctions.map(f => f.metrics.maxNestingDepth);
  const lineCounts = allFunctions.map(f => f.metrics.lineCount);
  const typeAnnotated = allFunctions.filter(f => f.metrics.hasTypeAnnotations).length;

  const avgComplexity = complexities.reduce((a, b) => a + b, 0) / complexities.length;
  const avgNestingDepth = nestingDepths.reduce((a, b) => a + b, 0) / nestingDepths.length;
  const avgFunctionLength = lineCounts.reduce((a, b) => a + b, 0) / lineCounts.length;
  const typeAnnotationCoverage = typeAnnotated / allFunctions.length;

  const maxComplexityFn = allFunctions.reduce((max, f) =>
    f.metrics.cyclomaticComplexity > (max?.metrics.cyclomaticComplexity ?? 0) ? f : max,
    allFunctions[0]);
  const maxNestingFn = allFunctions.reduce((max, f) =>
    f.metrics.maxNestingDepth > (max?.metrics.maxNestingDepth ?? 0) ? f : max,
    allFunctions[0]);

  // Phase 3c: Structural duplicates
  const structuralDuplicates = findStructuralDuplicates(allFunctions);

  // Phase 3d: Call graph
  const callGraph = buildCallGraph(allFunctions, trees);

  // Phase 3d: API surface
  const apiSurface = measureApiSurface(trees, allFunctions);

  // Phase 3d: Function scores
  const functionScores = scoreFunctions(allFunctions);
  functionScores.sort((a, b) => a.score - b.score); // worst first

  return {
    functions: allFunctions.map(f => f.metrics),
    avgComplexity,
    maxComplexity: maxComplexityFn?.metrics ?? null,
    avgNestingDepth,
    maxNestingDepth: maxNestingFn?.metrics ?? null,
    avgFunctionLength,
    typeAnnotationCoverage,
    emptyCatchBlocks: emptyCatches,
    magicNumbers,
    structuralDuplicates,
    callGraph,
    apiSurface,
    functionScores: functionScores.slice(0, 20), // top 20 worst
    totalFilesAnalyzed,
    totalFunctionsAnalyzed: allFunctions.length,
  };
}

// Stratified sample by directory
function sampleFiles(files: WalkEntry[], max: number): WalkEntry[] {
  const byDir = new Map<string, WalkEntry[]>();
  for (const f of files) {
    const dir = f.relativePath.split('/').slice(0, 2).join('/');
    const group = byDir.get(dir) ?? [];
    group.push(f);
    byDir.set(dir, group);
  }

  const result: WalkEntry[] = [];
  const perDir = Math.max(1, Math.floor(max / byDir.size));
  for (const [, group] of byDir) {
    result.push(...group.slice(0, perDir));
    if (result.length >= max) break;
  }
  return result.slice(0, max);
}
