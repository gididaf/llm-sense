import { access, readFile, readdir } from 'node:fs/promises';
import { join, basename, relative } from 'node:path';
import type { MonorepoPackage } from '../types.js';

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function countFilesRecursive(dirPath: string, depth: number = 0): Promise<number> {
  if (depth > 5) return 0;
  let count = 0;
  try {
    const items = await readdir(dirPath, { withFileTypes: true });
    for (const item of items) {
      if (item.name.startsWith('.') || item.name === 'node_modules' || item.name === 'dist' || item.name === 'build') continue;
      if (item.isFile()) count++;
      else if (item.isDirectory()) count += await countFilesRecursive(join(dirPath, item.name), depth + 1);
    }
  } catch {}
  return count;
}

// Discovers packages within common monorepo directory conventions.
async function discoverPackagesInDir(rootPath: string, dir: string): Promise<MonorepoPackage[]> {
  const packages: MonorepoPackage[] = [];
  const dirPath = join(rootPath, dir);

  try {
    const items = await readdir(dirPath, { withFileTypes: true });
    for (const item of items) {
      if (!item.isDirectory() || item.name.startsWith('.')) continue;
      const pkgDir = join(dirPath, item.name);

      // Check for package.json, go.mod, Cargo.toml, or pyproject.toml
      const hasPkgJson = await fileExists(join(pkgDir, 'package.json'));
      const hasGoMod = await fileExists(join(pkgDir, 'go.mod'));
      const hasCargo = await fileExists(join(pkgDir, 'Cargo.toml'));
      const hasPyproject = await fileExists(join(pkgDir, 'pyproject.toml'));

      if (hasPkgJson || hasGoMod || hasCargo || hasPyproject) {
        let name = item.name;
        if (hasPkgJson) {
          try {
            const pkg = JSON.parse(await readFile(join(pkgDir, 'package.json'), 'utf-8'));
            if (pkg.name) name = pkg.name;
          } catch {}
        }

        const fileCount = await countFilesRecursive(pkgDir);
        packages.push({
          name,
          path: pkgDir,
          relativePath: relative(rootPath, pkgDir),
          fileCount,
        });
      }
    }
  } catch {}

  return packages;
}

// Detects if a directory is a monorepo and discovers its packages.
export async function detectMonorepo(rootPath: string): Promise<{ isMonorepo: boolean; packages: MonorepoPackage[] }> {
  const packages: MonorepoPackage[] = [];

  // Check for workspace config files
  const hasWorkspaceConfig =
    await fileExists(join(rootPath, 'pnpm-workspace.yaml')) ||
    await fileExists(join(rootPath, 'lerna.json')) ||
    await fileExists(join(rootPath, 'turbo.json'));

  // Check for npm/yarn workspaces in package.json
  let hasPackageJsonWorkspaces = false;
  try {
    const pkg = JSON.parse(await readFile(join(rootPath, 'package.json'), 'utf-8'));
    if (pkg.workspaces) hasPackageJsonWorkspaces = true;
  } catch {}

  // Discover packages from common directories
  const monorepoDirectories = ['packages', 'apps', 'libs', 'modules', 'services'];
  for (const dir of monorepoDirectories) {
    if (await fileExists(join(rootPath, dir))) {
      const found = await discoverPackagesInDir(rootPath, dir);
      packages.push(...found);
    }
  }

  // Also check top-level directories that look like standalone packages
  // (common in non-standard monorepos like backend/ + frontend/)
  const topLevelDirs = ['backend', 'frontend', 'server', 'client', 'api', 'web', 'app', 'mobile'];
  const existingPaths = new Set(packages.map(p => p.path));
  for (const dir of topLevelDirs) {
    const dirPath = join(rootPath, dir);
    if (existingPaths.has(dirPath) || !await fileExists(dirPath)) continue;

    const hasPkgJson = await fileExists(join(dirPath, 'package.json'));
    const hasGoMod = await fileExists(join(dirPath, 'go.mod'));
    if (hasPkgJson || hasGoMod) {
      let name = dir;
      if (hasPkgJson) {
        try {
          const pkg = JSON.parse(await readFile(join(dirPath, 'package.json'), 'utf-8'));
          if (pkg.name) name = pkg.name;
        } catch {}
      }
      const fileCount = await countFilesRecursive(dirPath);
      packages.push({ name, path: dirPath, relativePath: dir, fileCount });
    }
  }

  // A monorepo has either workspace config or 2+ discovered packages
  const isMonorepo = hasWorkspaceConfig || hasPackageJsonWorkspaces || packages.length >= 2;

  return { isMonorepo, packages };
}
