import { describe, expect, test } from 'bun:test';

import { Skill } from '@/core/skill';
import {
  codeSimplifier,
  developerExperience,
  docsUpdate,
  prReview,
  publicDocs,
} from '@/skills';

const cases = [
  { skill: prReview, name: 'pr-review' },
  { skill: docsUpdate, name: 'docs-update' },
  { skill: publicDocs, name: 'public-docs' },
  { skill: developerExperience, name: 'developer-experience' },
  { skill: codeSimplifier, name: 'code-simplifier' },
] as const;

describe('skills bundle', () => {
  test('exposes every expected skill as a Skill instance', (): void => {
    for (const { skill } of cases) {
      expect(skill).toBeInstanceOf(Skill);
    }
  });

  for (const { skill, name } of cases) {
    describe(name, () => {
      test('parses the name from frontmatter', (): void => {
        expect(skill.name).toBe(name);
      });

      test('has a non-empty description', (): void => {
        expect(skill.description.length).toBeGreaterThan(0);
        expect(skill.description).not.toContain('\n');
      });

      test('strips the YAML frontmatter from the body', (): void => {
        expect(skill.content).not.toMatch(/^---/);
        expect(skill.content.length).toBeGreaterThan(0);
      });
    });
  }
});
