import pkg from '../package.json' with { type: 'json' };

// Bundle every entry declared in package.json `exports` (the single source of
// truth for the subpath list).
const entries = Object.values(pkg.exports);
const proc = Bun.spawn(
  [
    'bun',
    'build',
    ...entries,
    '--outdir',
    './dist',
    '--target',
    'node',
    '--external',
    'zod',
    '--external',
    '@opentelemetry/api',
    '--root',
    './src',
  ],
  { stdout: 'inherit', stderr: 'inherit' },
);
process.exit(await proc.exited);
