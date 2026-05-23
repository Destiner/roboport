import {
  Agent,
  Model,
  type CreateMessageParams,
  type CreateMessageResponse,
  type SearchHit,
} from '@/core';
import type { ToolCallPart, ToolResultPart } from '@/message';
import {
  prReview,
  docsUpdate,
  publicDocs,
  developerExperience,
} from '@/skills';

const skills = [prReview, docsUpdate, publicDocs, developerExperience];

console.log('Loaded skills:');
for (const skill of skills) {
  const lines = skill.content.split('\n').length;
  console.log(
    `  - ${skill.name} (${skill.content.length} chars, ${lines} lines)`,
  );
}

class ScriptedModel extends Model {
  private turn = 0;
  async createMessage(
    _params: CreateMessageParams,
  ): Promise<CreateMessageResponse> {
    this.turn += 1;
    if (this.turn === 1) {
      return {
        id: 'msg_1',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call_1',
            toolName: 'Skill',
            input: { skill: 'pr-review' },
          },
        ],
        stopReason: 'tool_use',
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    }
    return {
      id: 'msg_2',
      content: [{ type: 'text', text: 'done' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }
  async searchWeb(): Promise<SearchHit[]> {
    return [];
  }
}

const agent = new Agent({
  model: new ScriptedModel(),
  prompt: 'You are a coding assistant.',
  tools: [],
  skills,
});

const session = await agent.createSession({
  prompt: 'Review my branch.',
});

const toolResult = session.messages
  .filter((m) => m.role === 'tool')
  .flatMap((m) => (m.content as ToolResultPart[]))
  .find((r) => r.toolName === 'Skill');

if (!toolResult) {
  console.error('FAIL — no Skill tool result in session.');
  process.exit(1);
}

const output = toolResult.output as string;
const expectedHeader = '<skill name="pr-review">';
const expectedBodyMarker = '# PR review';
const pass =
  output.startsWith(expectedHeader) && output.includes(expectedBodyMarker);

console.log(`\nSkill-tool roundtrip: ${pass ? 'PASS' : 'FAIL'}`);
if (!pass) {
  console.error('Unexpected tool output:', output.slice(0, 200));
  process.exit(1);
}
console.log(`Body delivered: ${output.length} chars`);

const calls: ToolCallPart[] = [];
for (const msg of session.messages) {
  if (msg.role !== 'assistant') continue;
  for (const part of msg.content) {
    if (part.type === 'tool-call') calls.push(part);
  }
}
console.log(
  `Tool calls observed: ${calls.map((c) => c.toolName).join(', ')}`,
);
