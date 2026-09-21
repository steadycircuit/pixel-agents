import { closeSync, openSync, readSync, statSync } from 'node:fs';

export interface ConversationMessage {
  role: 'user' | 'assistant';
  text: string;
  timestamp?: string;
}

export interface ConversationPage {
  messages: ConversationMessage[];
  nextCursor?: string;
  historyRevision: string;
}

const MAX_HISTORY_BYTES = 4 * 1024 * 1024;
const MAX_HISTORY_MESSAGES = 10_000;

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
  return readConversationPage(file, undefined, maxMessages).messages;
}

/** Read a bounded tail of a host-owned transcript and page backward by message index. */
export function readConversationPage(file: string, cursor?: string, limit = 80): ConversationPage {
  let source: string;
  let historyRevision = 'missing';
  try {
    const stat = statSync(file);
    historyRevision = `${stat.size}:${Math.floor(stat.mtimeMs)}`;
    const length = Math.min(stat.size, MAX_HISTORY_BYTES);
    const offset = stat.size - length;
    const buffer = Buffer.alloc(length);
    let bytesRead: number;
    const descriptor = openSync(file, 'r');
    try {
      bytesRead = readSync(descriptor, buffer, 0, length, offset);
    } finally {
      closeSync(descriptor);
    }
    source = buffer.toString('utf8', 0, bytesRead);
    if (offset > 0) {
      const firstNewline = source.indexOf('\n');
      source = firstNewline === -1 ? '' : source.slice(firstNewline + 1);
    }
  } catch {
    return { messages: [], historyRevision };
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
      if (messages.length >= MAX_HISTORY_MESSAGES) break;
      messages.push({
        role,
        text: text.trim(),
        timestamp: typeof record.timestamp === 'string' ? record.timestamp : undefined,
      });
    } catch {
      // A partial final JSONL line is normal while the CLI is writing.
    }
  }
  const parsedLimit = Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), 200) : 80;
  const requestedEnd = cursor === undefined ? messages.length : Number(cursor);
  const end = Number.isSafeInteger(requestedEnd)
    ? Math.min(Math.max(requestedEnd, 0), messages.length)
    : messages.length;
  const start = Math.max(0, end - parsedLimit);
  return {
    messages: messages.slice(start, end),
    nextCursor: start > 0 ? String(start) : undefined,
    historyRevision,
  };
}
