import { describe, expect, it } from 'vitest';

import type { DesktopSnapshot } from '../../core/src/desktop/types.js';
import { EventBridge } from '../../desktop/src/eventBridge.js';

const snapshot: DesktopSnapshot = {
  protocolVersion: 1,
  epoch: 'host-epoch',
  revision: 0,
  appVersion: '1.0.0',
  catalogVersion: 'catalog-test',
  hooks: {
    claude: { installed: false, consent: 'unanswered' },
    codex: { installed: false, consent: 'unanswered' },
  },
  consentRequests: [],
  agents: [],
  seats: {},
  seatsRevision: 0,
  settings: {
    soundEnabled: true,
    alwaysShowLabels: false,
    ghostHeadlessAgents: false,
    watchAllSessions: false,
    showAreas: false,
    hooksInfoShown: false,
    workspaces: [],
    providerExecutables: {},
    hooksEnabled: { claude: false, codex: false },
  },
  providers: [],
  layout: null,
  layoutRevision: 0,
};

describe('EventBridge', () => {
  it('gives each subscription an immutable bootstrap revision and ordered events', () => {
    const bridge = new EventBridge(() => snapshot);
    const received: number[] = [];
    const subscription = bridge.subscribe((event) => received.push(event.revision));

    expect(subscription.snapshot.revision).toBe(0);
    bridge.publish({ type: 'runtimeStatusChanged', status: 'ready' });
    bridge.publish({ type: 'resyncRequired', reason: 'test' });

    expect(received).toEqual([1, 2]);
    subscription.release();
    bridge.publish({ type: 'runtimeStatusChanged', status: 'stopping' });
    expect(received).toEqual([1, 2]);
  });
});
