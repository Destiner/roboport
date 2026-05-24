import { Agent, type Message } from 'drone';
import { codex } from 'drone/harness';
import { OpenAIModel } from 'drone/models';
import { prReview } from 'drone/skills';

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

if (!prNumber) throw new Error('PR_NUMBER is required');
if (!repo) throw new Error('GITHUB_REPOSITORY is required');

const agent = new Agent({
  model: new OpenAIModel('gpt-5.5'),
  prompt: codex.system,
  tools: codex.tools,
  skills: [prReview],
});

const session = await agent.createSession({
  prompt: `Review PR #${prNumber} in ${repo} and post your findings to GitHub.

You are explicitly authorized to post:
- One inline comment per line-level finding via \`gh api repos/${repo}/pulls/${prNumber}/comments\`.
- A summary review with the severity-tiered markdown body and verdict via \`gh pr review ${prNumber}\` (\`--comment\`, or \`--request-changes\` if the verdict is Request changes).

Skip inline comments if there are no line-level findings.`,
});

logMessages(session.messages);
