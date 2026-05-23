import { z } from 'zod';

import type { Message, ToolCallPart, ToolResultPart } from './message';
import { createMessage } from './models/anthropic';

type MaybePromise<T> = T | Promise<T>;

class Model {
  modelName: string;
  options: {
    apiKey?: string;
  };

  constructor(
    modelName: string,
    options?: {
      apiKey?: string;
    },
  ) {
    this.modelName = modelName;
    this.options = options || {};
  }
}

class Tool<TSchema extends z.ZodTypeAny = z.ZodTypeAny, TResult = unknown> {
  name: string;
  description: string;
  inputSchema: TSchema;
  execute: (input: z.infer<TSchema>) => MaybePromise<TResult>;

  constructor({
    name,
    description,
    inputSchema,
    execute,
  }: {
    name: string;
    description: string;
    inputSchema: TSchema;
    execute: (input: z.infer<TSchema>) => MaybePromise<TResult>;
  }) {
    this.name = name;
    this.description = description;
    this.inputSchema = inputSchema;
    this.execute = execute;
  }
}

class Skill {
  name: string;
  description: string;
  content: string;

  constructor({
    name,
    description,
    content,
  }: {
    name: string;
    description: string;
    content: string;
  }) {
    this.name = name;
    this.description = description;
    this.content = content;
  }
}

interface Session {
  messages: Message[];
}

class Agent {
  model: Model;
  prompt: string;
  tools: Tool[];
  skills: Skill[];

  constructor({
    model,
    prompt,
    tools,
    skills,
  }: {
    model: Model;
    prompt: string;
    tools: Tool[];
    skills: Skill[];
  }) {
    this.model = model;
    this.prompt = prompt;
    this.tools = tools;
    this.skills = skills;
  }

  async createSession({ prompt }: { prompt: string }): Promise<Session> {
    const apiKey = this.model.options.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        'No Anthropic API key found. Set ANTHROPIC_API_KEY or pass apiKey to Model.',
      );
    }

    let system = this.prompt;
    if (this.skills.length > 0) {
      const skillsList = this.skills
        .map((skill) => `- ${skill.name}: ${skill.description}`)
        .join('\n');
      system = `${system}\n\n# Skills available\n${skillsList}`;
    }

    const anthropicTools = this.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: z.toJSONSchema(tool.inputSchema) as object,
    }));

    const toolByName = new Map(this.tools.map((tool) => [tool.name, tool]));

    const messages: Message[] = [
      { role: 'system', content: system },
      { role: 'user', content: prompt },
    ];

    while (true) {
      const response = await createMessage({
        apiKey,
        model: this.model.modelName,
        messages,
        tools: anthropicTools,
      });

      messages.push({ role: 'assistant', content: response.content });

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
          const parsed = tool.inputSchema.parse(call.input);
          const output = await tool.execute(parsed);
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

      messages.push({ role: 'tool', content: results });
    }

    return { messages };
  }
}

export { Model, Tool, Skill, Agent, type Session };
