import { access, copyFile, writeFile } from 'fs/promises';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import pkg from '../package.json' with { type: 'json' };

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(here, '..');
const distDir = resolve(packageDir, 'dist');

const subpaths = [
  'gateways',
  'harness',
  'mcp',
  'models',
  'skills',
  'triggers',
] as const;

const exportsField: Record<string, { types: string; import: string }> = {
  '.': { types: './index.d.ts', import: './index.js' },
};
for (const sp of subpaths) {
  exportsField[`./${sp}`] = {
    types: `./${sp}/index.d.ts`,
    import: `./${sp}/index.js`,
  };
}

const source = pkg as Record<string, unknown>;

const distManifest: Record<string, unknown> = {
  name: pkg.name,
  version: pkg.version,
  description: pkg.description,
  author: pkg.author,
  license: pkg.license,
  repository: pkg.repository,
  homepage: pkg.homepage,
  bugs: pkg.bugs,
  keywords: pkg.keywords,
  engines: pkg.engines,
  type: pkg.type,
  main: './index.js',
  types: './index.d.ts',
  exports: exportsField,
};

// Mirror the dependency contract onto the packed manifest. zod is a peer
// dependency, so without copying `peerDependencies` the published package
// would declare nothing and consumers would only discover the missing peer as
// a runtime module-resolution failure.
for (const field of ['dependencies', 'peerDependencies'] as const) {
  if (source[field]) distManifest[field] = source[field];
}

await writeFile(
  resolve(distDir, 'package.json'),
  JSON.stringify(distManifest, null, 2) + '\n',
);

// Carry the README and license into the package so npm renders them on the
// package page; LICENSE is optional today (the manifest declares UNLICENSED).
for (const file of ['README.md', 'LICENSE']) {
  const from = resolve(packageDir, file);
  try {
    await access(from);
  } catch {
    continue;
  }
  await copyFile(from, resolve(distDir, file));
}
