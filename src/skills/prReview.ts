import { Skill } from '@/core';

import content from './prReview.md' with { type: 'text' };

const prReview = new Skill({
  name: 'pr-review',
  description:
    "Reviews a pull request or branch diff and produces a short, severity-tiered report (must-fix / should-consider / nits) with a final verdict. Use when the user asks to review a PR, review their branch, look at someone else's PR, or mentions a PR number / URL.",
  content,
});

export default prReview;
