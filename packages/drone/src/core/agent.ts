import { z } from 'zod';

import type { Trigger, TriggerHandler, Unsub } from '@/triggers/core';

import type { McpClient } from './mcp';
import type {
  Message,
  TextPart,
  ThinkingPart,
  ToolCallPart,
  ToolResultPart,
} from './message';
import type { Model } from './model';
import { Session, Turn, type SessionInternals, type TurnEmit } from './session';
import { Skill } from './skill';
import {
  Tool,
  createRegistry,
  type SearchHit,
  type SessionState,
  type StopReason,
  type ToolContext,
  type ToolRegistry,
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
  cwd?: string;
  private registrations: Registration[] = [];
  private unsubs: Unsub[] = [];

  constructor({
    model,
    prompt,
    tools,
    skills,
    mcp,
    cwd,
  }: {
    model: Model;
    prompt: string;
    tools: Tool[];
    skills: Skill[];
    mcp?: McpClient[];
    cwd?: string;
  }) {
    this.model = model;
    this.prompt = prompt;
    this.tools = tools;
    this.skills = skills;
    this.mcp = mcp ?? [];
    this.cwd = cwd;
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

  // Build a fresh session, optionally seeded with a prior message history for
  // resumption. MCP connections are lazy — no I/O until the first send().
  session(init?: { messages?: Message[]; cwd?: string }): Session {
    const initialMessages = init?.messages
      ? [...init.messages]
      : ([] as Message[]);
    const sessionCwd = init?.cwd ?? this.cwd ?? process.cwd();
    const state: SessionState = {
      messages: initialMessages,
      store: new Map(),
    };
    let activeTurn: Turn | null = null;
    let mcpConnected = false;
    let allTools: Tool[] | null = null;
    let registry: ToolRegistry | null = null;
    let ctx: ToolContext | null = null;

    const ensureReady = async (): Promise<{
      tools: Tool[];
      registry: ToolRegistry;
      ctx: ToolContext;
    }> => {
      if (!allTools || !registry || !ctx) {
        const mcpToolGroups = await Promise.all(
          this.mcp.map((mcp) => mcp.connect()),
        );
        mcpConnected = true;
        allTools = [
          ...this.tools,
          ...mcpToolGroups.flat(),
          ...(this.skills.length > 0 ? [this.buildSkillTool()] : []),
        ];
        registry = createRegistry(allTools);
        ctx = {
          complete: async (p: string): Promise<string> => {
            const response = await this.model.createMessage({
              messages: [{ role: 'user', content: p }],
            });
            return response.content
              .filter((block): block is TextPart => block.type === 'text')
              .map((block) => block.text)
              .join('\n');
          },
          searchWeb: (query, opts): Promise<SearchHit[]> =>
            this.model.searchWeb(query, opts),
          session: state,
          tools: registry,
          cwd: sessionCwd,
        };
        // Seed the message log with the system prompt once we know the tool set.
        if (
          state.messages.length === 0 ||
          state.messages[0]?.role !== 'system'
        ) {
          state.messages.unshift({
            role: 'system',
            content: this.buildSystem(allTools),
          });
        }
      }
      return { tools: allTools, registry, ctx };
    };

    const internals: SessionInternals = {
      send: (prompt) => {
        if (activeTurn !== null) {
          throw new Error(
            'Session.send() called while another turn is in flight.',
          );
        }
        const turn = new Turn(async (turnCtx) => {
          try {
            const ready = await ensureReady();
            state.messages.push(toUserMessage(prompt));
            await runAgentLoop({
              model: this.model,
              state,
              registry: ready.registry,
              ctx: ready.ctx,
              emit: turnCtx.emit,
              signal: turnCtx.signal,
            });
            return [...state.messages];
          } finally {
            activeTurn = null;
          }
        });
        activeTurn = turn;
        return turn;
      },
      close: async (): Promise<void> => {
        const pending = activeTurn;
        if (pending) {
          pending.abort('session closed');
          // Wait for the in-flight loop to observe the abort and unwind
          // (including any tool call mid-flight) before tearing down MCP.
          await Promise.resolve(pending).catch(() => {});
        }
        if (mcpConnected) {
          await Promise.all(this.mcp.map((mcp) => mcp.disconnect()));
          mcpConnected = false;
        }
      },
    };

    return new Session(internals, state);
  }
}

function toUserMessage(prompt: string | TextPart[]): Message {
  if (typeof prompt === 'string') return { role: 'user', content: prompt };
  return { role: 'user', content: prompt };
}

interface AgentLoopArgs {
  model: Model;
  state: SessionState;
  registry: ToolRegistry;
  ctx: ToolContext;
  emit: TurnEmit;
  signal: AbortSignal;
}

async function runAgentLoop({
  model,
  state,
  registry,
  ctx,
  emit,
  signal,
}: AgentLoopArgs): Promise<void> {
  while (true) {
    if (signal.aborted) break;

    const active = registry.loaded();
    const toolByName = new Map(active.map((tool) => [tool.name, tool]));

    emit({ type: 'message-start' });

    const assistantContent: (TextPart | ThinkingPart | ToolCallPart)[] = [];
    let stopReason: StopReason = 'end_turn';
    let usage = { inputTokens: 0, outputTokens: 0 };

    try {
      for await (const event of model.streamMessage({
        messages: state.messages,
        tools: active,
        signal,
      })) {
        switch (event.type) {
          case 'text-delta':
            emit({ type: 'text-delta', text: event.text });
            break;
          case 'text-end':
            assistantContent.push({ type: 'text', text: event.text });
            emit({ type: 'text', text: event.text });
            break;
          case 'thinking-delta':
            emit({ type: 'thinking-delta', text: event.text });
            break;
          case 'thinking-end':
            assistantContent.push({
              type: 'thinking',
              text: event.text,
              ...(event.signature !== undefined
                ? { signature: event.signature }
                : {}),
              ...(event.redactedData !== undefined
                ? { redactedData: event.redactedData }
                : {}),
            });
            emit({
              type: 'thinking',
              text: event.text,
              ...(event.signature !== undefined
                ? { signature: event.signature }
                : {}),
            });
            break;
          case 'tool-call':
            assistantContent.push({
              type: 'tool-call',
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              input: event.input,
            });
            emit({
              type: 'tool-call',
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              input: event.input,
            });
            break;
          case 'message-end':
            stopReason = event.stopReason;
            usage = event.usage;
            break;
          default:
            break;
        }
      }
    } catch (error) {
      if (signal.aborted) {
        state.messages.push({ role: 'assistant', content: assistantContent });
        break;
      }
      const err = error instanceof Error ? error : new Error(String(error));
      emit({ type: 'error', error: err });
      throw err;
    }

    state.messages.push({ role: 'assistant', content: assistantContent });
    emit({ type: 'message-end', usage });

    if (stopReason !== 'tool_use') {
      emit({ type: 'turn-end' });
      break;
    }

    const toolCalls = assistantContent.filter(
      (block): block is ToolCallPart => block.type === 'tool-call',
    );
    const results: ToolResultPart[] = [];
    for (const call of toolCalls) {
      if (signal.aborted) break;
      const tool = toolByName.get(call.toolName);
      const result = await runTool(tool, call, ctx);
      results.push(result);
      emit({
        type: 'tool-result',
        toolCallId: result.toolCallId,
        toolName: result.toolName,
        output: result.output,
        isError:
          typeof result.output === 'string'
            ? result.output.startsWith('Error:')
            : false,
      });
    }

    state.messages.push({ role: 'tool', content: results });

    if (signal.aborted) break;
  }
}

async function runTool(
  tool: Tool | undefined,
  call: ToolCallPart,
  ctx: ToolContext,
): Promise<ToolResultPart> {
  if (!tool) {
    return {
      type: 'tool-result',
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      output: `Error: tool "${call.toolName}" not found`,
    };
  }
  try {
    const parsed = tool.parse(call.input);
    const output = await tool.execute(parsed, ctx);
    return {
      type: 'tool-result',
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      output,
    };
  } catch (error) {
    return {
      type: 'tool-result',
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      output: `Error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// eslint-disable-next-line import-x/prefer-default-export
export { Agent };
