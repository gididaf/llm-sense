import { walkDir, buildTokenHeatmap, buildContextWindowProfile, type WalkEntry } from '../core/fs.js';
import { analyzeFileSizes } from '../analyzers/fileSizes.js';
import { analyzeDirectoryStructure } from '../analyzers/directoryStructure.js';
import { analyzeNaming } from '../analyzers/naming.js';
import { analyzeDocumentation } from '../analyzers/documentation.js';
import { analyzeImports } from '../analyzers/imports.js';
import { analyzeModularity } from '../analyzers/modularity.js';
import { analyzeNoise } from '../analyzers/noise.js';
import { analyzeDevInfra } from '../analyzers/devInfra.js';
import { analyzeSecurity } from '../analyzers/security.js';
import { analyzeDuplicates } from '../analyzers/duplicates.js';
import { runLanguageChecks } from '../analyzers/languageChecks.js';
import type { StaticAnalysisResult } from '../types.js';

export async function runStaticAnalysis(
  targetPath: string,
  verbose: boolean,
  noAst: boolean = false,
): Promise<{ result: StaticAnalysisResult; entries: WalkEntry[] }> {
  if (verbose) console.log('  Walking directory tree...');
  const entries = await walkDir(targetPath);

  if (verbose) console.log(`  Found ${entries.filter(e => e.isFile).length} files in ${entries.filter(e => e.isDir).length} directories`);

  // Run analyzers (file-sizes is async, others are mostly sync)
  if (verbose) console.log('  Analyzing file sizes...');
  const fileSizes = await analyzeFileSizes(entries);

  if (verbose) console.log('  Analyzing directory structure...');
  const directoryStructure = analyzeDirectoryStructure(entries);

  if (verbose) console.log('  Analyzing naming conventions...');
  const naming = analyzeNaming(entries);

  if (verbose) console.log('  Analyzing documentation...');
  const documentation = await analyzeDocumentation(targetPath, entries);

  if (verbose) console.log('  Analyzing imports...');
  const importsAnalysis = await analyzeImports(entries);
  const imports = importsAnalysis.result;
  const fragmentationRatio = importsAnalysis.fragmentationRatio;
  // Flatten graph for dependency visualization
  const importGraph: Array<{ source: string; target: string }> = [];
  for (const [source, targets] of importsAnalysis.graph) {
    for (const target of targets) {
      importGraph.push({ source, target });
    }
  }

  if (verbose) console.log('  Analyzing modularity...');
  const modularity = analyzeModularity(entries);

  if (verbose) console.log('  Analyzing noise...');
  const noise = await analyzeNoise(entries);

  if (verbose) console.log('  Analyzing developer infrastructure...');
  const devInfra = await analyzeDevInfra(targetPath, entries);

  if (verbose) console.log('  Analyzing security...');
  const security = await analyzeSecurity(targetPath, entries);

  if (verbose) console.log('  Building token heatmap...');
  const tokenHeatmap = buildTokenHeatmap(entries);

  if (verbose) console.log('  Detecting semantic duplicates...');
  const duplicates = await analyzeDuplicates(entries);

  if (verbose) console.log('  Building context window profile...');
  const contextProfile = buildContextWindowProfile(tokenHeatmap);

  if (verbose) console.log('  Running language-specific checks...');
  const languageChecks = await runLanguageChecks(entries);

  // AST analysis (tree-sitter) — runs after regex checks, provides deeper insights
  let astAnalysis: import('../types.js').AstAnalysisResult | undefined;
  if (!noAst) {
    try {
      if (verbose) console.log('  Running AST analysis (tree-sitter)...');
      const { analyzeWithAst } = await import('../analyzers/astChecks.js');
      const result = await analyzeWithAst(entries, verbose);
      if (result) {
        astAnalysis = result;
        if (verbose) console.log(`  ✓ AST: ${result.totalFunctionsAnalyzed} functions in ${result.totalFilesAnalyzed} files`);
      } else if (verbose) {
        console.log('  AST analysis skipped (no supported files or grammars unavailable)');
      }
    } catch (e) {
      if (verbose) console.log(`  AST analysis failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  return {
    result: {
      fileSizes,
      directoryStructure,
      naming,
      documentation,
      imports,
      modularity,
      noise,
      devInfra,
      security,
      tokenHeatmap,
      duplicates,
      fragmentationRatio,
      contextProfile,
      languageChecks,
      astAnalysis,
      importGraph,
    },
    entries,
  };
}
