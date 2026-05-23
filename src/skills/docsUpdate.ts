import { Skill } from '@/core';

import content from './docsUpdate.md' with { type: 'text' };

const docsUpdate = new Skill({
  name: 'docs-update',
  description:
    "Keeps a repo's internal docs (README.md, AGENTS.md / CLAUDE.md, docs/**/*.md) in sync with a code change. Routes each fact to one canonical home, preserves the existing voice, and skips trivial changes. Use after a PR-sized change set when public API, commands, structure, or stack claims may have shifted.",
  content,
});

export default docsUpdate;
