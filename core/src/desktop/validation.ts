import type { DesktopSeat, ProviderId, SessionKey } from './types.js';
export const MAX_PROMPT_LENGTH = 20_000;
export const MAX_EVENT_BYTES = 8 * 1024 * 1024;
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function isProviderId(value: unknown): value is ProviderId {
  return value === 'claude' || value === 'codex';
}
export function assertPrompt(prompt: unknown): asserts prompt is string {
  if (typeof prompt !== 'string' || prompt.trim().length === 0 || prompt.length > MAX_PROMPT_LENGTH)
    throw new Error('Prompt must be non-empty and at most 20,000 characters');
}
export function parseSessionKey(value: unknown): SessionKey {
  if (
    !isRecord(value) ||
    !isProviderId(value.providerId) ||
    typeof value.sessionId !== 'string' ||
    !value.sessionId
  )
    throw new Error('Invalid session key');
  return { providerId: value.providerId, sessionId: value.sessionId };
}
export function validateSeat(value: unknown): DesktopSeat {
  if (!isRecord(value)) throw new Error('Invalid seat');
  const seat: DesktopSeat = {};
  if (
    value.palette !== undefined &&
    (typeof value.palette !== 'number' ||
      !Number.isInteger(value.palette) ||
      value.palette < 0 ||
      value.palette > 5)
  )
    throw new Error('Invalid seat palette');
  if (
    value.hueShift !== undefined &&
    (typeof value.hueShift !== 'number' ||
      !Number.isFinite(value.hueShift) ||
      value.hueShift < 0 ||
      value.hueShift >= 360)
  )
    throw new Error('Invalid seat hue');
  if (value.seatId !== undefined && (typeof value.seatId !== 'string' || value.seatId.length > 128))
    throw new Error('Invalid seat id');
  Object.assign(seat, value);
  return seat;
}
export function assertPayloadSize(value: unknown): void {
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_EVENT_BYTES)
    throw new Error('Payload exceeds size limit');
}
