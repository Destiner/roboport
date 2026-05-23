import { Skill } from '@/core';

import content from './publicDocs.md' with { type: 'text' };

const publicDocs = new Skill({
  name: 'public-docs',
  description:
    'Writes and maintains external, user-facing docs for an SDK / API / product, run from a docs repo with upstream source repos as context. Classifies each page as quickstart / concept / how-to / reference / recipe, prefers generated shape with hand-written meaning, and avoids duplication with the SDK README. Use when working in a docs repo (Mintlify, Docusaurus, or plain markdown) or when the user asks to write or refresh public/user-facing docs.',
  content,
});

export default publicDocs;
