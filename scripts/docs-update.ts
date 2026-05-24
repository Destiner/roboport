import { Agent, type Message } from 'drone';
import { codex } from 'drone/harness';
import { OpenAIModel } from 'drone/models';
import { docsUpdate } from 'drone/skills';

function logMessages(messages: Message[]): void {
  for (const message of messages) {
    switch (message.role) {
      case 'system':
        break;
      case 'user': {
        const text =
          typeof message.content === 'string'
            ? message.content
            : message.content.map((part) => part.text).join('');
        console.log(`[user] ${text}`);
        break;
      }
      case 'assistant':
        for (const part of message.content) {
          switch (part.type) {
            case 'text':
              console.log(`[assistant] ${part.text}`);
              break;
            case 'tool-call':
              console.log(
                `[assistant:tool-call] ${part.toolName}(${JSON.stringify(part.input)})`,
              );
              break;
          }
        }
        break;
      case 'tool':
        for (const part of message.content) {
          console.log(
            `[tool-result] ${part.toolName} -> ${JSON.stringify(part.output)}`,
          );
        }
        break;
    }
  }
}

const prNumber = process.env.PR_NUMBER;
const repo = process.env.GITHUB_REPOSITORY;
const baseRef = process.env.BASE_REF;
const headRef = process.env.HEAD_REF;

if (!prNumber) throw new Error('PR_NUMBER is required');
if (!repo) throw new Error('GITHUB_REPOSITORY is required');
if (!baseRef) throw new Error('BASE_REF is required');
if (!headRef) throw new Error('HEAD_REF is required');

const agent = new Agent({
  model: new OpenAIModel('gpt-5.5'),
  prompt: codex.system,
  tools: codex.tools,
  skills: [docsUpdate],
});

const session = await agent.createSession({
  prompt: `You are running on PR #${prNumber} in ${repo}.
Branch: ${headRef}. Base: origin/${baseRef}. The branch is already checked out and git identity is preconfigured.

1. Diff against origin/${baseRef} and apply the docs-update skill.
2. If no edits are warranted, print "docs in sync" and stop — do not commit.
3. If you applied edits:
   - Run \`bun run check\` and \`bun run typecheck\`.
   - Stage only the docs files you edited.
   - Commit with message: \`docs: sync internal docs with PR #${prNumber}\` followed by a blank line and \`[skip ci]\`.
   - Push to origin/${headRef}.

Do not amend or force-push. Do not edit source files.`,
});

logMessages(session.messages);
