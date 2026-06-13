#!/usr/bin/env bun
import { $ } from 'bun';

// The published package is the generated `dist/` manifest, not the workspace
// source (whose `exports` point at `src` so workspace apps import TS directly).
// So we build `dist/` and publish from there rather than from the package root.
await $`bun --filter roboport build`;

const distDir = 'packages/roboport/dist';
const { name, version } = await Bun.file(`${distDir}/package.json`).json();

// changesets/action runs this command on every push to main that has no
// pending changesets, so make it idempotent: skip versions already on the
// registry instead of failing on "cannot publish over previously published".
const view = await $`npm view ${name}@${version} version`.nothrow().quiet();
if (view.exitCode === 0 && view.stdout.toString().trim() === version) {
  console.log(`${name}@${version} is already published, skipping`);
  process.exit(0);
}

await $`npm publish --access public`.cwd(distDir);

// changesets/action parses this line to create the GitHub release + git tag.
console.log(`New tag: ${name}@${version}`);
