import { access, copyFile, writeFile } from 'fs/promises';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import pkg from '../package.json' with { type: 'json' };

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(here, '..');
const distDir = resolve(packageDir, 'dist');

// Derive the dist exports from the source `exports` map: `./src/x/index.ts` ->
// `{ types: ./x/index.d.ts, import: ./x/index.js }`. package.json keeps the
// single source of truth for the subpath list.
const exportsField: Record<string, { types: string; import: string }> = {};
for (const [key, srcPath] of Object.entries(pkg.exports)) {
  const base = srcPath.replace(/^\.\/src\//, './').replace(/\.ts$/, '');
  exportsField[key] = { types: `${base}.d.ts`, import: `${base}.js` };
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
// package page. LICENSE is a symlink to the repo root; copyFile dereferences
// it, so the packed file is the real MIT text.
for (const file of ['README.md', 'LICENSE']) {
  const from = resolve(packageDir, file);
  try {
    await access(from);
  } catch {
    continue;
  }
  await copyFile(from, resolve(distDir, file));
}
