import { Skill } from '@/core';

import content from './index.md' with { type: 'text' };

const developerExperience = new Skill({
  name: 'developer-experience',
  description:
    'Reviews an SDK or API repo as a linter for developer experience and agent experience (AX). Surfaces papercuts: friction, inconsistent naming, unidiomatic REST, weak errors, untyped boundaries, and patterns that make the surface hard for LLM-driven agents to consume. Use when the user asks to audit an SDK / API for DX, AX, ergonomics, or how it feels to use.',
  content,
});

export default developerExperience;
