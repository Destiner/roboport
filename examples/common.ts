import type { Message } from '@/message';

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

export { logMessages };
