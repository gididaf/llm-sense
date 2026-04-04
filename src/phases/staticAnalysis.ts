import { walkDir, buildTokenHeatmap, type WalkEntry } from '../core/fs.js';
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
import type { StaticAnalysisResult } from '../types.js';

export async function runStaticAnalysis(
  targetPath: string,
  verbose: boolean,
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
    },
    entries,
  };
}
