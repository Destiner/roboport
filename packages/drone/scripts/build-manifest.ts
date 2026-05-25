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

const distManifest = {
  name: pkg.name,
  version: pkg.version,
  author: pkg.author,
  license: pkg.license,
  type: pkg.type,
  main: './index.js',
  types: './index.d.ts',
  exports: exportsField,
  dependencies: pkg.dependencies,
};

await writeFile(
  resolve(distDir, 'package.json'),
  JSON.stringify(distManifest, null, 2) + '\n',
);
