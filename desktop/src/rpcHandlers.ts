import { randomUUID } from 'node:crypto';

import { BrowserView } from 'electrobun/main';

import type { ErrorCode, RpcResult } from '../../core/src/desktop/types.js';
import { ASSET_IDS } from '../../core/src/desktop/types.js';
import { assertPrompt, isProviderId, parseSessionKey } from '../../core/src/desktop/validation.js';
import type { RuntimeHost } from '../../server/src/runtimeHost.js';
import type { createConsentService } from './consentService.js';
import type { EventBridge } from './eventBridge.js';
import { updateHooksPreference } from './hooksPreference.js';
import { fail, ok } from './rpcResult.js';
import type { DesktopRPCSchema } from './rpcSchema.js';
import type { createUpdateService } from './updates.js';

export interface DesktopRpcNativeServices {
  selectWorkspaceFolder(): Promise<string | undefined>;
  setHooksEnabled(providerId: 'claude' | 'codex', enabled: boolean): Promise<void>;
  areHooksInstalled(providerId: 'claude' | 'codex'): Promise<boolean>;
}

export function createDesktopRPC(
  host: RuntimeHost,
  bridge: EventBridge,
  deliverEvent: (event: import('../../core/src/desktop/types.js').EventEnvelope) => void,
  nativeServices: DesktopRpcNativeServices,
  consent: ReturnType<typeof createConsentService>,
  updates: ReturnType<typeof createUpdateService>,
) {
  const selections = new Map<string, { clientId: string; path: string; expiresAt: number }>();
  return BrowserView.defineRPC<DesktopRPCSchema>({
    handlers: {
      requests: {
        getBootstrapState: ({ protocolVersion }) => {
          if (protocolVersion !== 1)
            return fail('INVALID_ARGUMENT', 'Unsupported desktop protocol');
          const subscription = bridge.subscribe(deliverEvent);
          return ok({
            snapshot: subscription.snapshot,
            epoch: bridge.getEpoch(),
            revision: subscription.snapshot.revision,
            subscriptionId: subscription.subscriptionId,
          });
        },
        getAssetChunk: ({ catalogVersion, assetId, chunkIndex }) => {
          if (
            typeof catalogVersion !== 'string' ||
            !(ASSET_IDS as readonly unknown[]).includes(assetId) ||
            !Number.isSafeInteger(chunkIndex)
          )
            return fail('INVALID_ARGUMENT', 'Invalid asset request');
          try {
            return ok(host.getAssetChunk(catalogVersion, assetId, chunkIndex));
          } catch (error) {
            const stale = error instanceof Error && error.message === 'STALE_CLIENT';
            return stale
              ? fail('STALE_CLIENT', 'Assets changed; reload the catalog', true)
              : fail('NOT_FOUND', 'Asset chunk was not found');
          }
        },
        releaseSubscription: ({ subscriptionId }) => {
          bridge.release(subscriptionId);
          return ok(undefined);
        },
        launchAgent: async ({
          providerId,
          workspaceId,
          initialPrompt,
          bypassPermissions,
          epoch,
        }) => {
          if (epoch !== host.snapshot().epoch)
            return fail('STALE_CLIENT', 'Desktop state changed; refresh and try again');
          if (
            !isProviderId(providerId) ||
            typeof workspaceId !== 'string' ||
            typeof bypassPermissions !== 'boolean'
          )
            return fail('INVALID_ARGUMENT', 'Invalid launch request');
          try {
            if (initialPrompt !== undefined) assertPrompt(initialPrompt);
            const operation = await host.launchAgent(
              providerId,
              workspaceId,
              initialPrompt,
              bypassPermissions,
            );
            return ok({ operationId: operation.operationId });
          } catch (error) {
            return operationFailure(error, 'Unable to launch agent');
          }
        },
        reEmploySession: async ({ sessionKey, epoch }) => {
          if (epoch !== host.snapshot().epoch)
            return fail('STALE_CLIENT', 'Desktop state changed; refresh and try again');
          try {
            const operation = await host.reEmploySession(parseSessionKey(sessionKey));
            return ok({ operationId: operation.operationId });
          } catch (error) {
            return operationFailure(error, 'Unable to re-employ session');
          }
        },
        sendAgentPrompt: async ({ agentId, prompt, epoch }) => {
          if (epoch !== host.snapshot().epoch)
            return fail('STALE_CLIENT', 'Desktop state changed; refresh and try again');
          try {
            if (!Number.isSafeInteger(agentId)) throw new Error('INVALID_ARGUMENT');
            assertPrompt(prompt);
            const operation = await host.sendAgentPrompt(agentId, prompt);
            return ok({ operationId: operation.operationId });
          } catch (error) {
            return operationFailure(error, 'Unable to send prompt');
          }
        },
        cancelAgentTurn: ({ operationId, epoch }) => {
          if (epoch !== host.snapshot().epoch)
            return fail('STALE_CLIENT', 'Desktop state changed; refresh and try again');
          if (typeof operationId !== 'string')
            return fail('INVALID_ARGUMENT', 'Invalid operation id');
          const operation = host.cancelOperation(operationId);
          return operation ? ok(operation) : fail('NOT_FOUND', 'Operation was not found');
        },
        getOperationStatus: ({ operationId }) => {
          if (typeof operationId !== 'string')
            return fail('INVALID_ARGUMENT', 'Invalid operation id');
          const operation = host.operationStatus(operationId);
          return operation ? ok(operation) : fail('NOT_FOUND', 'Operation was not found');
        },
        focusAgent: ({ agentId }) => {
          if (!Number.isSafeInteger(agentId)) return fail('INVALID_ARGUMENT', 'Invalid agent id');
          const agent = host.focusAgent(agentId);
          return agent ? ok(agent) : fail('NOT_FOUND', 'Agent was not found');
        },
        closeAgent: async ({ agentId, epoch }) => {
          if (epoch !== host.snapshot().epoch)
            return fail('STALE_CLIENT', 'Desktop state changed; refresh and try again');
          if (!Number.isSafeInteger(agentId)) return fail('INVALID_ARGUMENT', 'Invalid agent id');
          try {
            await host.closeAgent(agentId);
            return ok(undefined);
          } catch (error) {
            return operationFailure(error, 'Unable to close agent');
          }
        },
        getAgentConversation: ({ agentId, cursor, limit }) => {
          if (!Number.isSafeInteger(agentId)) return fail('INVALID_ARGUMENT', 'Invalid agent id');
          if (
            (cursor !== undefined && (typeof cursor !== 'string' || !/^\d+$/.test(cursor))) ||
            (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 200))
          )
            return fail('INVALID_ARGUMENT', 'Invalid conversation page');
          try {
            return ok(host.getAgentConversation(agentId, cursor, limit));
          } catch (error) {
            return operationFailure(error, 'Unable to read conversation');
          }
        },
        selectFolder: async ({ clientId, purpose }) => {
          if (typeof clientId !== 'string' || purpose !== 'workspace')
            return fail('INVALID_ARGUMENT', 'Invalid folder selection request');
          const selected = await nativeServices.selectWorkspaceFolder();
          if (!selected) return ok(null);
          const selectionId = randomUUID();
          selections.set(selectionId, {
            clientId,
            path: selected,
            expiresAt: Date.now() + 5 * 60_000,
          });
          return ok({ selectionId, path: selected });
        },
        addWorkspace: async ({ selectionId, clientId, epoch }) => {
          if (epoch !== host.snapshot().epoch)
            return fail('STALE_CLIENT', 'Desktop state changed; refresh and try again');
          const selection = selections.get(selectionId);
          selections.delete(selectionId);
          if (!selection || selection.clientId !== clientId || selection.expiresAt < Date.now())
            return fail('INVALID_ARGUMENT', 'Folder selection expired');
          try {
            return ok(await host.addWorkspace(selection.path));
          } catch (error) {
            return operationFailure(error, 'Unable to add workspace');
          }
        },
        removeWorkspace: async ({ workspaceId, epoch }) => {
          if (epoch !== host.snapshot().epoch)
            return fail('STALE_CLIENT', 'Desktop state changed; refresh and try again');
          if (typeof workspaceId !== 'string')
            return fail('INVALID_ARGUMENT', 'Invalid workspace id');
          try {
            await host.removeWorkspace(workspaceId);
            return ok(undefined);
          } catch (error) {
            return operationFailure(error, 'Unable to remove workspace');
          }
        },
        saveLayout: async ({ layout, expectedLayoutRevision }) => {
          try {
            return ok({ layoutRevision: await host.saveLayout(layout, expectedLayoutRevision) });
          } catch (error) {
            return fail(
              error instanceof Error && error.message === 'CONFLICT' ? 'CONFLICT' : 'IO_ERROR',
              'Unable to save layout',
              true,
            );
          }
        },
        saveAgentSeats: async ({ seats, expectedSeatsRevision }) => {
          try {
            return ok({ seatsRevision: await host.saveSeats(seats, expectedSeatsRevision) });
          } catch (error) {
            return fail(
              error instanceof Error && error.message === 'CONFLICT' ? 'CONFLICT' : 'IO_ERROR',
              'Unable to save seats',
              true,
            );
          }
        },
        setSetting: async ({ key, value }) => {
          try {
            return ok(await host.setSetting(key, value));
          } catch (error) {
            return fail(
              error instanceof Error && error.message === 'INVALID_ARGUMENT'
                ? 'INVALID_ARGUMENT'
                : 'IO_ERROR',
              'Unable to save setting',
              true,
            );
          }
        },
        getUpdateState: async () => ok(await updates.state()),
        runUpdateAction: async ({ action, epoch }) => {
          if (epoch !== host.snapshot().epoch)
            return fail('STALE_CLIENT', 'Desktop state changed; refresh and try again');
          if (action !== 'check' && action !== 'download' && action !== 'apply')
            return fail('INVALID_ARGUMENT', 'Unknown update action');
          return ok(await updates.run(action));
        },
        listPreviousSessions: async () => {
          try {
            return ok(await host.listPreviousSessions());
          } catch {
            return fail('IO_ERROR', 'Unable to read previous sessions', true);
          }
        },
        answerHooksConsent: async ({ providerId, choice, epoch }) => {
          if (epoch !== host.snapshot().epoch)
            return fail('STALE_CLIENT', 'Desktop state changed; refresh and try again');
          try {
            await consent.answer(providerId, choice);
            return ok(undefined);
          } catch (error) {
            return error instanceof Error && error.message === 'INVALID_ARGUMENT'
              ? fail('INVALID_ARGUMENT', 'Invalid consent answer')
              : fail('IO_ERROR', 'Unable to record the answer', true);
          }
        },
        setHooksEnabled: (request: Parameters<typeof updateHooksPreference>[2]) =>
          updateHooksPreference(host, nativeServices, request),
        _: () => fail('UNSUPPORTED', 'This desktop action is not available yet'),
      },
      messages: {},
    },
  });
}

function operationFailure<T>(error: unknown, fallback: string): RpcResult<T> {
  const message = error instanceof Error ? error.message : '';
  const known: ErrorCode[] = [
    'INVALID_ARGUMENT',
    'NOT_FOUND',
    'UNSUPPORTED',
    'PROVIDER_UNAVAILABLE',
    'SESSION_BUSY',
    'SPAWN_FAILED',
  ];
  const code = known.includes(message as ErrorCode) ? (message as ErrorCode) : 'SPAWN_FAILED';
  return fail(code, fallback, code === 'SESSION_BUSY' || code === 'SPAWN_FAILED');
}
