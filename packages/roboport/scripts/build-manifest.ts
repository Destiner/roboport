import { writeFile } from 'fs/promises';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import pkg from '../package.json' with { type: 'json' };

const here = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(here, '..', 'dist');

const subpaths = ['harness', 'mcp', 'models', 'skills', 'triggers'] as const;

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
  author: pkg.author,
  license: pkg.license,
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
