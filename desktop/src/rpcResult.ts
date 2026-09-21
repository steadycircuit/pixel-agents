import { randomUUID } from 'node:crypto';

import type { ErrorCode, RpcError, RpcResult } from '../../core/src/desktop/types.js';

export function ok<T>(value: T): RpcResult<T> {
  return { ok: true, value };
}
export function fail<T>(code: ErrorCode, message: string, retryable = false): RpcResult<T> {
  const error: RpcError = { code, message, retryable, correlationId: randomUUID() };
  return { ok: false, error };
}
export function safely<T>(operation: () => T): RpcResult<T> {
  try {
    return ok(operation());
  } catch (error) {
    return fail('INTERNAL', error instanceof Error ? error.message : 'Desktop operation failed');
  }
}
