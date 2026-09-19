import { readFileSync } from 'node:fs';

export interface ConversationMessage {
  role: 'user' | 'assistant';
  text: string;
  timestamp?: string;
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (block): block is { type?: string; text?: string } => !!block && typeof block === 'object',
    )
    .filter(
      (block) =>
        block.type === 'text' ||
        block.type === 'input_text' ||
        block.type === 'output_text' ||
        block.type === undefined,
    )
    .map((block) => block.text ?? '')
    .filter(Boolean)
    .join('\n');
}

export function readConversation(file: string, maxMessages = 80): ConversationMessage[] {
  let source: string;
  try {
    source = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const messages: ConversationMessage[] = [];
  for (const line of source.split('\n')) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      const payload = record.payload as Record<string, unknown> | undefined;
      const payloadRole = payload?.role;
      const role =
        record.type === 'user' || record.type === 'assistant'
          ? record.type
          : payload?.type === 'message' && (payloadRole === 'user' || payloadRole === 'assistant')
            ? payloadRole
            : null;
      if (!role) continue;
      const nested = record.message as Record<string, unknown> | undefined;
      const text = textFromContent(nested?.content ?? record.content ?? payload?.content);
      if (!text.trim()) continue;
      messages.push({
        role,
        text: text.trim(),
        timestamp: typeof record.timestamp === 'string' ? record.timestamp : undefined,
      });
    } catch {
      // A partial final JSONL line is normal while the CLI is writing.
    }
  }
  return messages.slice(-maxMessages);
}
