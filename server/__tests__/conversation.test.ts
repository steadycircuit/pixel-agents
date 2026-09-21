import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readConversationPage } from '../src/conversation.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('host-owned conversation pages', () => {
  it('returns bounded pages from the latest messages without accepting arbitrary offsets', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pixel-conversation-'));
    roots.push(root);
    const file = path.join(root, 'session.jsonl');
    await writeFile(
      file,
      [
        JSON.stringify({ type: 'user', content: 'one' }),
        JSON.stringify({ type: 'assistant', content: 'two' }),
        JSON.stringify({ type: 'user', content: 'three' }),
      ].join('\n'),
    );
    const latest = readConversationPage(file, undefined, 2);
    expect(latest.messages.map((message) => message.text)).toEqual(['two', 'three']);
    expect(latest.nextCursor).toBe('1');
    const older = readConversationPage(file, latest.nextCursor, 2);
    expect(older.messages.map((message) => message.text)).toEqual(['one']);
    expect(older.nextCursor).toBeUndefined();
    expect(
      readConversationPage(file, 'not-a-cursor', 2).messages.map((message) => message.text),
    ).toEqual(['two', 'three']);
  });
});
