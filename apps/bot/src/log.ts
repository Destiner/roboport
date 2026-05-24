import type { Message } from 'drone';

function logMessages(label: string, messages: Message[]): void {
  for (const message of messages) {
    switch (message.role) {
      case 'system':
        break;
      case 'user': {
        const text =
          typeof message.content === 'string'
            ? message.content
            : message.content.map((part) => part.text).join('');
        console.log(`[${label}] [user] ${text}`);
        break;
      }
      case 'assistant':
        for (const part of message.content) {
          switch (part.type) {
            case 'text':
              console.log(`[${label}] [assistant] ${part.text}`);
              break;
            case 'tool-call':
              console.log(
                `[${label}] [assistant:tool-call] ${part.toolName}(${JSON.stringify(part.input)})`,
              );
              break;
          }
        }
        break;
      case 'tool':
        for (const part of message.content) {
          console.log(
            `[${label}] [tool-result] ${part.toolName} -> ${JSON.stringify(part.output)}`,
          );
        }
        break;
    }
  }
}

// eslint-disable-next-line import-x/prefer-default-export
export { logMessages };
