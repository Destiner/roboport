import type { Message, TurnEvent } from '@/core';

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

async function logEvents(stream: AsyncIterable<TurnEvent>): Promise<void> {
  for await (const event of stream) {
    switch (event.type) {
      case 'text-delta':
        process.stdout.write(event.text);
        break;
      case 'text':
        process.stdout.write('\n');
        break;
      case 'tool-call':
        console.log(
          `\n[tool-call] ${event.toolName}(${JSON.stringify(event.input)})`,
        );
        break;
      case 'tool-result':
        console.log(
          `[tool-result] ${event.toolName} -> ${JSON.stringify(event.output)}`,
        );
        break;
      case 'error':
        console.error(`[error] ${event.error.message}`);
        break;
    }
  }
}

export { logEvents, logMessages };
