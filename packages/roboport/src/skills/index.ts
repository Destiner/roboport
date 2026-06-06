import { Skill } from '@/core';

import codeSimplifierRaw from './codeSimplifier/SKILL.md' with { type: 'text' };
import developerExperienceRaw from './developerExperience/SKILL.md' with { type: 'text' };
import docsUpdateRaw from './docsUpdate/SKILL.md' with { type: 'text' };
import prReviewRaw from './prReview/SKILL.md' with { type: 'text' };
import publicDocsRaw from './publicDocs/SKILL.md' with { type: 'text' };

function parseSkill(raw: string): Skill {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
  if (!match) {
    throw new Error('Skill is missing YAML frontmatter.');
  }
  const [, frontmatter, body] = match;
  if (frontmatter === undefined || body === undefined) {
    throw new Error('Skill frontmatter could not be parsed.');
  }
  const fields: Record<string, string> = {};
  for (const line of frontmatter.split('\n')) {
    const kv = /^([A-Za-z][\w-]*):\s*(.+)$/.exec(line);
    if (kv?.[1] && kv[2]) fields[kv[1]] = kv[2].trim();
  }
  const name = fields.name;
  const description = fields.description;
  if (!name) throw new Error('Skill frontmatter is missing "name".');
  if (!description)
    throw new Error('Skill frontmatter is missing "description".');
  return new Skill({ name, description, content: body.trimStart() });
}

const prReview = parseSkill(prReviewRaw);
const docsUpdate = parseSkill(docsUpdateRaw);
const publicDocs = parseSkill(publicDocsRaw);
const developerExperience = parseSkill(developerExperienceRaw);
const codeSimplifier = parseSkill(codeSimplifierRaw);

export {
  prReview,
  docsUpdate,
  publicDocs,
  developerExperience,
  codeSimplifier,
};
