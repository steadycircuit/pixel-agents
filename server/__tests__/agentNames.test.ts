import { describe, expect, it } from 'vitest';

import {
  AGENT_FIRST_NAME_COUNT,
  getAgentDisplayName,
  normalizeFolderSurname,
} from '../src/agentNames.js';

describe('agent names', () => {
  it('provides a large fixed first-name pool', () => {
    expect(AGENT_FIRST_NAME_COUNT).toBeGreaterThanOrEqual(200);
  });

  it('normalizes the folder into a surname and stays deterministic', () => {
    expect(normalizeFolderSurname('pixel-agents_2')).toBe('Pixelagents');
    expect(getAgentDisplayName('session-1', 'pixel-agents')).toBe(
      getAgentDisplayName('session-1', 'pixel-agents'),
    );
    expect(getAgentDisplayName('session-1', 'pixel-agents')).toMatch(/^[A-Za-z]+ Pixelagents$/);
  });
});
