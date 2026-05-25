import { z } from 'zod';

import type { Trigger, TriggerHandler, Unsub } from '@/triggers/core';

import type { McpClient } from './mcp';
import type { TextPart, ToolCallPart, ToolResultPart } from './message';
import type { Model } from './model';
import { Skill } from './skill';
import {
  Tool,
  createRegistry,
  type Session,
  type SessionState,
  type ToolContext,
} from './tool';

interface Registration<T = unknown> {
  trigger: Trigger<T>;
  handler: TriggerHandler<T>;
}

class Agent {
  model: Model;
  prompt: string;
  tools: Tool[];
  skills: Skill[];
  mcp: McpClient[];
  private registrations: Registration[] = [];
  private unsubs: Unsub[] = [];

  constructor({
    model,
    prompt,
    tools,
    skills,
    mcp,
  }: {
    model: Model;
    prompt: string;
    tools: Tool[];
    skills: Skill[];
    mcp?: McpClient[];
  }) {
    this.model = model;
    this.prompt = prompt;
    this.tools = tools;
    this.skills = skills;
    this.mcp = mcp ?? [];
  }

  on<T>(trigger: Trigger<T>, handler: TriggerHandler<T>): void {
    this.registrations.push({ trigger, handler } as Registration);
  }

  async start(): Promise<void> {
    for (const { trigger, handler } of this.registrations) {
      const unsub = await trigger.start((event) => {
        void Promise.resolve()
          .then(() => handler(event))
          .catch((error: unknown) => {
            const message =
              error instanceof Error ? error.message : String(error);
            console.error(
              `[drone] trigger "${trigger.name}" handler failed: ${message}`,
            );
          });
      });
      this.unsubs.push(unsub);
    }
  }

  async stop(): Promise<void> {
    const unsubs = this.unsubs;
    this.unsubs = [];
    await Promise.all(unsubs.map((u) => u()));
  }

  buildSystem(allTools: Tool[]): string {
    let system = this.prompt;
    if (this.skills.length > 0) {
      const skillsList = this.skills
        .map((skill) => `- ${skill.name}: ${skill.description}`)
        .join('\n');
      system = `${system}\n\n# Skills\nThe following skills are available. When a task matches one, call the \`Skill\` tool with that skill's name to load its full content before proceeding.\n\n${skillsList}`;
    }
    const deferred = allTools.filter((tool) => tool.deferred);
    if (deferred.length > 0) {
      const list = deferred.map((tool) => `- ${tool.name}`).join('\n');
      system = `${system}\n\n# Deferred tools\nThese tools are available but their schemas are not loaded. Use ToolSearch to load them before calling.\n${list}`;
    }
    return system;
  }

  private buildSkillTool(): Tool {
    const byName = new Map(this.skills.map((skill) => [skill.name, skill]));
    return new Tool({
      name: 'Skill',
      description:
        'Load the full content of a skill listed under "# Skills" in the system prompt. Call this when you decide a listed skill applies to the current task; the returned content extends your instructions for the rest of the session.',
      inputSchema: z.object({
        skill: z
          .string()
          .describe('Name of the skill to load (must match a listed skill).'),
      }),
      execute: ({ skill }): string => {
        const found = byName.get(skill);
        if (!found) {
          const available = [...byName.keys()].join(', ');
          throw new Error(
            `Skill "${skill}" not found. Available: ${available}`,
          );
        }
        return `<skill name="${found.name}">\n${found.content}\n</skill>`;
      },
    });
  }

  async createSession({ prompt }: { prompt: string }): Promise<Session> {
    const mcpToolGroups = await Promise.all(
      this.mcp.map((mcp) => mcp.connect()),
    );
    const allTools = [
      ...this.tools,
      ...mcpToolGroups.flat(),
      ...(this.skills.length > 0 ? [this.buildSkillTool()] : []),
    ];

    try {
      const state: SessionState = {
        messages: [
          { role: 'system', content: this.buildSystem(allTools) },
          { role: 'user', content: prompt },
        ],
        store: new Map(),
      };

      const registry = createRegistry(allTools);

      const ctx: ToolContext = {
        complete: async (p: string): Promise<string> => {
          const response = await this.model.createMessage({
            messages: [{ role: 'user', content: p }],
          });
          return response.content
            .filter((block): block is TextPart => block.type === 'text')
            .map((block) => block.text)
            .join('\n');
        },
        searchWeb: (query, opts) => this.model.searchWeb(query, opts),
        session: state,
        tools: registry,
      };

      while (true) {
        const active = registry.loaded();
        const toolByName = new Map(active.map((tool) => [tool.name, tool]));

        const response = await this.model.createMessage({
          messages: state.messages,
          tools: active,
        });

        state.messages.push({ role: 'assistant', content: response.content });

        if (response.stopReason !== 'tool_use') break;

        const toolCalls = response.content.filter(
          (block): block is ToolCallPart => block.type === 'tool-call',
        );

        const results: ToolResultPart[] = [];
        for (const call of toolCalls) {
          const tool = toolByName.get(call.toolName);
          if (!tool) {
            results.push({
              type: 'tool-result',
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              output: `Error: tool "${call.toolName}" not found`,
            });
            continue;
          }
          try {
            const parsed = tool.parse(call.input);
            const output = await tool.execute(parsed, ctx);
            results.push({
              type: 'tool-result',
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              output,
            });
          } catch (error) {
            results.push({
              type: 'tool-result',
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              output: `Error: ${error instanceof Error ? error.message : String(error)}`,
            });
          }
        }

        state.messages.push({ role: 'tool', content: results });
      }

      return { messages: state.messages };
    } finally {
      await Promise.all(this.mcp.map((mcp) => mcp.disconnect()));
    }
  }
}

// eslint-disable-next-line import-x/prefer-default-export
export { Agent };
