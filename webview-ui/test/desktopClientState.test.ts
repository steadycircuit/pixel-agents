/**
 * Desktop protocol client state: revision/epoch/subscription gating, snapshot application and the
 * legacy-message translation. Pure functions, so no Electroview or DOM is involved.
 */

import assert from 'node:assert/strict';

import { describe, test } from 'vitest';

import type {
  DesktopAgent,
  DesktopEvent,
  DesktopSnapshot,
  EventEnvelope,
} from '../../core/src/desktop/types.js';
import type { DesktopClientState } from '../src/transport/desktopClientState.js';
import {
  reduceEnvelope,
  snapshotMessages,
  withSavedRevisions,
} from '../src/transport/desktopClientState.js';

function agent(agentId: number, overrides: Partial<DesktopAgent> = {}): DesktopAgent {
  return {
    agentId,
    sessionKey: { providerId: 'claude', sessionId: `s${agentId}` },
    cwd: '/work/project',
    displayName: `Agent ${agentId}`,
    isExternal: false,
    retained: false,
    dismissed: false,
    writerActive: false,
    status: 'idle',
    lastActivityAt: 0,
    ...overrides,
  };
}

function snapshot(overrides: Partial<DesktopSnapshot> = {}): DesktopSnapshot {
  return {
    protocolVersion: 1,
    epoch: 'epoch-1',
    revision: 5,
    appVersion: '1.0.0',
    catalogVersion: 'catalog-1',
    hooks: {
      claude: { installed: false, consent: 'unanswered' },
      codex: { installed: false, consent: 'unanswered' },
    },
    consentRequests: [],
    agents: [],
    seats: {},
    settings: {
      soundEnabled: true,
      alwaysShowLabels: false,
      ghostHeadlessAgents: false,
      watchAllSessions: false,
      showAreas: true,
      hooksInfoShown: false,
      workspaces: [],
      providerExecutables: {},
      hooksEnabled: { claude: false, codex: false },
    },
    providers: [],
    layout: { version: 1 },
    layoutRevision: 3,
    seatsRevision: 2,
    ...overrides,
  };
}

const state = (overrides: Partial<DesktopSnapshot> = {}): DesktopClientState => ({
  subscriptionId: 'sub-1',
  snapshot: snapshot(overrides),
});

function envelope(revision: number, event: DesktopEvent, over: Partial<EventEnvelope> = {}) {
  return {
    protocolVersion: 1,
    subscriptionId: 'sub-1',
    epoch: 'epoch-1',
    revision,
    event,
    ...over,
  } as EventEnvelope;
}

describe('reduceEnvelope gating', () => {
  test('ignores events from a released subscription', () => {
    const before = state();
    const outcome = reduceEnvelope(
      before,
      envelope(6, { type: 'agentRemoved', agentId: 1 }, { subscriptionId: 'old' }),
    );
    assert.equal(outcome.kind, 'ignored');
  });

  test('ignores duplicates and replays at or below the snapshot revision', () => {
    for (const revision of [4, 5]) {
      const outcome = reduceEnvelope(
        state(),
        envelope(revision, { type: 'agentChanged', agent: agent(1) }),
      );
      assert.equal(outcome.kind, 'ignored');
    }
  });

  test('requests a resync on a revision gap, epoch change or protocol change', () => {
    const changed = { type: 'agentChanged', agent: agent(1) } as const;
    assert.deepEqual(reduceEnvelope(state(), envelope(7, changed)), {
      kind: 'resync',
      reason: 'missed events',
    });
    assert.equal(
      reduceEnvelope(state(), envelope(6, changed, { epoch: 'epoch-2' })).kind,
      'resync',
    );
    assert.equal(
      reduceEnvelope(state(), envelope(6, changed, { protocolVersion: 2 as never })).kind,
      'resync',
    );
  });

  test('honours an explicit resyncRequired event', () => {
    assert.deepEqual(
      reduceEnvelope(state(), envelope(6, { type: 'resyncRequired', reason: 'overflow' })),
      { kind: 'resync', reason: 'overflow' },
    );
  });

  test('advances the revision for events the renderer does not display', () => {
    const outcome = reduceEnvelope(
      state(),
      envelope(6, { type: 'runtimeStatusChanged', status: 'ready' }),
    );
    assert.ok(outcome.kind === 'applied');
    assert.equal(outcome.state.snapshot.revision, 6);
    assert.deepEqual(outcome.messages, []);
  });
});

describe('reduceEnvelope agents', () => {
  test('creates a character once, then reports tool and status changes', () => {
    const created = reduceEnvelope(
      state(),
      envelope(6, { type: 'agentChanged', agent: agent(1, { palette: 2 }) }),
    );
    assert.ok(created.kind === 'applied');
    assert.deepEqual(
      created.messages.map((message) => message.type),
      ['agentCreated', 'agentStatus'],
    );
    assert.equal(created.state.snapshot.agents.length, 1);

    const working = agent(1, {
      status: 'working',
      activity: {
        tools: [{ toolId: 't1', toolName: 'Read', status: 'Reading a.ts' }],
        permissionRequired: true,
        awaitingInput: false,
      },
    });
    const next = reduceEnvelope(
      created.state,
      envelope(7, { type: 'agentChanged', agent: working }),
    );
    assert.ok(next.kind === 'applied');
    assert.deepEqual(
      next.messages.map((message) => message.type),
      ['agentToolStart', 'agentStatus', 'agentToolPermission'],
    );
    assert.equal(next.state.snapshot.agents.length, 1);
  });

  test('removes the agent from the snapshot so a re-appearing agent is created again', () => {
    const start = state({ agents: [agent(1)] });
    const removed = reduceEnvelope(start, envelope(6, { type: 'agentRemoved', agentId: 1 }));
    assert.ok(removed.kind === 'applied');
    assert.deepEqual(removed.messages, [{ type: 'agentClosed', id: 1 }]);
    assert.equal(removed.state.snapshot.agents.length, 0);

    const back = reduceEnvelope(
      removed.state,
      envelope(7, { type: 'agentChanged', agent: agent(1) }),
    );
    assert.ok(back.kind === 'applied');
    assert.equal(back.messages[0]?.type, 'agentCreated');
  });

  test('a permission request keeps the agent active so the waiting bubble cannot replace it', () => {
    const start = state({ agents: [agent(1, { status: 'working' })] });
    const blocked = reduceEnvelope(
      start,
      envelope(6, {
        type: 'agentChanged',
        agent: agent(1, {
          status: 'waiting',
          activity: { tools: [], permissionRequired: true, awaitingInput: false },
        }),
      }),
    );
    assert.ok(blocked.kind === 'applied');
    assert.deepEqual(
      blocked.messages.map((message) => message.type),
      ['agentToolPermission'],
    );
  });

  test('a removal for an unknown agent emits nothing', () => {
    const outcome = reduceEnvelope(state(), envelope(6, { type: 'agentRemoved', agentId: 9 }));
    assert.ok(outcome.kind === 'applied');
    assert.deepEqual(outcome.messages, []);
  });

  test('keeps agents ordered by id and clears permission and finished tools', () => {
    const blocked = agent(2, {
      activity: {
        tools: [{ toolId: 't', toolName: 'Bash', status: 'Running' }],
        permissionRequired: true,
        awaitingInput: false,
      },
    });
    const start = state({ agents: [blocked, agent(3)] });
    const inserted = reduceEnvelope(start, envelope(6, { type: 'agentChanged', agent: agent(1) }));
    assert.ok(inserted.kind === 'applied');
    assert.deepEqual(
      inserted.state.snapshot.agents.map((a) => a.agentId),
      [1, 2, 3],
    );
    const cleared = reduceEnvelope(
      inserted.state,
      envelope(7, { type: 'agentChanged', agent: agent(2) }),
    );
    assert.ok(cleared.kind === 'applied');
    assert.deepEqual(
      cleared.messages.map((message) => message.type),
      ['agentToolDone', 'agentToolPermissionClear', 'agentStatus'],
    );
  });
});

describe('layout revisions', () => {
  test('a foreign layout change reloads the office and advances the revision', () => {
    const outcome = reduceEnvelope(
      state(),
      envelope(6, { type: 'layoutChanged', layout: { version: 2 }, layoutRevision: 4 }),
    );
    assert.ok(outcome.kind === 'applied');
    assert.deepEqual(outcome.messages, [{ type: 'layoutLoaded', layout: { version: 2 } }]);
    assert.equal(outcome.state.snapshot.layoutRevision, 4);
  });

  test('the echo of our own save is not replayed into the office', () => {
    const saved = withSavedRevisions(state(), { layoutRevision: 4 });
    const outcome = reduceEnvelope(
      saved,
      envelope(6, { type: 'layoutChanged', layout: { version: 2 }, layoutRevision: 4 }),
    );
    assert.ok(outcome.kind === 'applied');
    assert.deepEqual(outcome.messages, []);
  });

  test('saved revisions never move backwards', () => {
    const saved = withSavedRevisions(state(), { layoutRevision: 1, seatsRevision: 1 });
    assert.equal(saved.snapshot.layoutRevision, 3);
    assert.equal(saved.snapshot.seatsRevision, 2);
  });
});

describe('provider identity', () => {
  const claudeAgent = agent(1);
  const codexAgent = agent(2, { sessionKey: { providerId: 'codex', sessionId: 'x2' } });

  test('a first snapshot tells the renderer which provider owns each agent', () => {
    const messages = snapshotMessages(undefined, snapshot({ agents: [claudeAgent, codexAgent] }));
    const existing = messages.find((message) => message.type === 'existingAgents');
    assert.ok(existing && existing.type === 'existingAgents');
    assert.deepEqual(existing.agentProviders, { 1: 'claude', 2: 'codex' });
  });

  test('a newly appearing agent carries its provider', () => {
    const outcome = reduceEnvelope(
      state(),
      envelope(6, { type: 'agentChanged', agent: codexAgent }),
    );
    assert.ok(outcome.kind === 'applied');
    const created = outcome.messages.find((message) => message.type === 'agentCreated');
    assert.ok(created && created.type === 'agentCreated');
    assert.equal(created.providerId, 'codex');
  });
});

describe('snapshotMessages settings', () => {
  test('a dismissed tip stays dismissed, and an undismissed one is offered', () => {
    const settingsOf = (hooksInfoShown: boolean) => {
      const base = snapshot();
      const messages = snapshotMessages(
        undefined,
        snapshot({ settings: { ...base.settings, hooksInfoShown } }),
      );
      const loaded = messages.find((message) => message.type === 'settingsLoaded');
      assert.ok(loaded && loaded.type === 'settingsLoaded');
      return loaded.hooksInfoShown;
    };
    assert.equal(settingsOf(true), true);
    assert.equal(settingsOf(false), false);
  });
});

describe('snapshotMessages consent', () => {
  const asks = [
    {
      providerId: 'claude' as const,
      headline: 'Install hooks?',
      disclosure: 'Edits settings.json',
    },
  ];
  test('the first-run asks and install state come with the first snapshot only', () => {
    const first = snapshotMessages(
      undefined,
      snapshot({
        consentRequests: asks,
        hooks: {
          claude: { installed: false, consent: 'unanswered' },
          codex: { installed: true, consent: 'granted' },
        },
      }),
    );
    const request = first.find((message) => message.type === 'hooksConsentRequest');
    assert.ok(request && request.type === 'hooksConsentRequest');
    assert.equal(request.headline, 'Install hooks?');
    assert.deepEqual(
      first.filter((message) => message.type === 'hooksStatus'),
      [
        { type: 'hooksStatus', providerId: 'claude', installed: false },
        { type: 'hooksStatus', providerId: 'codex', installed: true },
      ],
    );
    assert.equal(first.at(-1)?.type, 'hooksConsentRequest', 'asks come after the office loads');
    const refresh = snapshotMessages(snapshot(), snapshot({ consentRequests: asks }));
    assert.ok(!refresh.some((message) => message.type === 'hooksConsentRequest'));
  });
});

describe('snapshotMessages', () => {
  test('a first snapshot loads settings, workspaces, existing agents and layout', () => {
    const messages = snapshotMessages(
      undefined,
      snapshot({
        agents: [agent(1, { palette: 4 })],
        seats: { 'claude:s1': { seatId: 'chair-1' } },
      }),
    );
    assert.deepEqual(
      messages.map((message) => message.type),
      [
        'settingsLoaded',
        'workspaceFolders',
        'hooksStatus',
        'hooksStatus',
        'existingAgents',
        'layoutLoaded',
      ],
    );
    const existing = messages.find((message) => message.type === 'existingAgents');
    assert.ok(existing && existing.type === 'existingAgents');
    assert.equal(existing.agentMeta[1]?.seatId, 'chair-1');
  });

  test('a refresh of the same host sends only what differs, never existingAgents again', () => {
    const before = snapshot({ agents: [agent(1), agent(2)] });
    const after = snapshot({
      agents: [agent(2, { status: 'working' }), agent(3)],
      settings: { ...before.settings, hooksEnabled: { claude: true, codex: false } },
    });
    const messages = snapshotMessages(before, after);
    assert.deepEqual(
      messages.map((message) => message.type),
      [
        'settingsLoaded',
        'workspaceFolders',
        'hooksStatus',
        'hooksStatus',
        'agentClosed',
        'agentStatus',
        'agentCreated',
        'agentStatus',
      ],
    );
    const settings = messages[0];
    assert.ok(settings && settings.type === 'settingsLoaded');
    assert.equal(settings.hooksEnabled, true);
  });

  test('a refresh reloads the layout only when its revision moved', () => {
    const before = snapshot();
    assert.ok(!snapshotMessages(before, snapshot()).some((m) => m.type === 'layoutLoaded'));
    assert.ok(
      snapshotMessages(before, snapshot({ layoutRevision: 9 })).some(
        (m) => m.type === 'layoutLoaded',
      ),
    );
  });
});
