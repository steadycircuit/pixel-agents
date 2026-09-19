import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { readConversation } from '../src/conversation.js';

describe('readConversation', () => {
  it('reads Codex response_item messages', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'pixel-agents-conversation-'));
    const file = path.join(dir, 'session.jsonl');
    writeFileSync(
      file,
      [
        {
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Continue this task' }],
          },
        },
        {
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'I will continue.' }],
          },
        },
      ]
        .map((record) => JSON.stringify(record))
        .join('\n'),
    );
    try {
      expect(readConversation(file)).toEqual([
        { role: 'user', text: 'Continue this task' },
        { role: 'assistant', text: 'I will continue.' },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
