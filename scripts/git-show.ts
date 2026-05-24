import { execSync } from 'node:child_process';

const sha = process.argv[2];

if (!sha) {
  console.error('usage: bun scripts/git-show.ts <sha>');
  process.exit(1);
}

const out = execSync(`git show ${sha}`, { encoding: 'utf8' });
console.log(out);
