// Thin wrappers over `gh api` for the bits the bot drives deterministically
// (rather than through the agent): check runs that surface progress in the PR
// UI, and the placeholder reply on the simplify-apply path. Every spawn passes
// env: process.env so the GitHub App installation token in GH_TOKEN reaches gh.

async function ghApi<T = unknown>(
  args: string[],
  body?: unknown,
): Promise<T | null> {
  const hasBody = body !== undefined;
  const proc = Bun.spawn(['gh', 'api', ...args], {
    stdin: hasBody ? 'pipe' : 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env,
  });
  if (hasBody) {
    proc.stdin?.write(JSON.stringify(body));
    proc.stdin?.end();
  }
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    console.error(
      `[bot] gh api ${args[0]} failed: ${stderr.trim() || `exit ${exitCode}`}`,
    );
    return null;
  }
  const text = (await new Response(proc.stdout).text()).trim();
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

type CheckConclusion = 'success' | 'neutral' | 'failure';

interface CheckRun {
  complete(
    conclusion: CheckConclusion,
    title: string,
    summary: string,
  ): Promise<void>;
}

// Open an in-progress check run on the PR head commit and return a handle to
// complete it. Returns null on failure so callers can `check?.complete(...)`
// without branching. The check is advisory: callers conclude `neutral` on
// success so it never gates a merge — keep it out of branch protection's
// required checks (only a GitHub App can create check runs, which the bot is).
async function startCheckRun(
  repo: string,
  sha: string,
  name: string,
): Promise<CheckRun | null> {
  const created = await ghApi<{ id: number }>(
    [`repos/${repo}/check-runs`, '--method', 'POST', '--input', '-'],
    { name, head_sha: sha, status: 'in_progress' },
  );
  if (!created?.id) return null;
  const { id } = created;
  return {
    async complete(conclusion, title, summary): Promise<void> {
      await ghApi(
        [`repos/${repo}/check-runs/${id}`, '--method', 'PATCH', '--input', '-'],
        { status: 'completed', conclusion, output: { title, summary } },
      );
    },
  };
}

// The PR's current head SHA. docs-update can push a commit mid-run that
// advances the head, so handlers re-resolve it to anchor a check on the commit
// the PR now shows rather than the one the webhook fired on.
async function prHeadSha(
  repo: string,
  prNumber: number,
): Promise<string | null> {
  const pr = await ghApi<{ head?: { sha?: string } }>([
    `repos/${repo}/pulls/${prNumber}`,
  ]);
  return pr?.head?.sha ?? null;
}

// Post a reply into an existing inline review-comment thread (anchored to the
// root comment) and return the new comment's id, or null on failure.
async function postThreadReply(
  repo: string,
  prNumber: number,
  rootCommentId: number,
  body: string,
): Promise<number | null> {
  const created = await ghApi<{ id: number }>(
    [
      `repos/${repo}/pulls/${prNumber}/comments`,
      '--method',
      'POST',
      '--input',
      '-',
    ],
    { body, in_reply_to: rootCommentId },
  );
  return created?.id ?? null;
}

async function editReviewComment(
  repo: string,
  commentId: number,
  body: string,
): Promise<void> {
  await ghApi(
    [
      `repos/${repo}/pulls/comments/${commentId}`,
      '--method',
      'PATCH',
      '--input',
      '-',
    ],
    { body },
  );
}

async function deleteReviewComment(
  repo: string,
  commentId: number,
): Promise<void> {
  await ghApi([
    `repos/${repo}/pulls/comments/${commentId}`,
    '--method',
    'DELETE',
  ]);
}

export {
  startCheckRun,
  prHeadSha,
  postThreadReply,
  editReviewComment,
  deleteReviewComment,
};
