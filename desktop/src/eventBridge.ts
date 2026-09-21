import { randomUUID } from 'node:crypto';

import type { DesktopEvent, DesktopSnapshot, EventEnvelope } from '../../core/src/desktop/types.js';

export class EventBridge {
  private revision = 0;
  private readonly epoch: string;
  private readonly subscribers = new Map<string, (event: EventEnvelope) => void>();
  constructor(private readonly snapshot: () => DesktopSnapshot) {
    this.epoch = snapshot().epoch;
  }
  subscribe(listener: (event: EventEnvelope) => void): {
    subscriptionId: string;
    snapshot: DesktopSnapshot;
    release: () => void;
  } {
    const subscriptionId = randomUUID();
    this.subscribers.set(subscriptionId, listener);
    return {
      subscriptionId,
      snapshot: { ...this.snapshot(), epoch: this.epoch, revision: this.revision },
      release: () => this.subscribers.delete(subscriptionId),
    };
  }
  release(subscriptionId: string): void {
    this.subscribers.delete(subscriptionId);
  }
  publish(event: DesktopEvent): void {
    this.revision += 1;
    const envelope: EventEnvelope = {
      protocolVersion: 1,
      subscriptionId: '',
      epoch: this.epoch,
      revision: this.revision,
      event,
    };
    for (const [subscriptionId, listener] of this.subscribers)
      listener({ ...envelope, subscriptionId });
  }
  getEpoch(): string {
    return this.epoch;
  }
}
