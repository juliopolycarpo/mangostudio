import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { type RealtimeInvalidateEvent, SETTINGS_TOPIC } from '@mangostudio/shared/realtime';
import {
  createRealtimeBus,
  getRealtimeBus,
  registerRealtimeBus,
  setRealtimeBusForTests,
} from '../../../src/services/realtime/realtime-bus';

describe('createRealtimeBus', () => {
  it('delivers publish only to subscribers for the same user', () => {
    const bus = createRealtimeBus();
    const userA: RealtimeInvalidateEvent[] = [];
    const userB: RealtimeInvalidateEvent[] = [];

    bus.subscribe('user-a', (event) => {
      userA.push(event);
    });
    bus.subscribe('user-b', (event) => {
      userB.push(event);
    });

    const event: RealtimeInvalidateEvent = {
      type: 'invalidate',
      topic: SETTINGS_TOPIC,
      scopes: ['app'],
    };

    bus.publish('user-a', event);

    expect(userA).toEqual([event]);
    expect(userB).toEqual([]);
  });

  it('stops delivery after unsubscribe', () => {
    const bus = createRealtimeBus();
    const received: RealtimeInvalidateEvent[] = [];
    const unsubscribe = bus.subscribe('user-1', (event) => {
      received.push(event);
    });

    bus.publish('user-1', { type: 'invalidate', topic: SETTINGS_TOPIC });
    unsubscribe();
    bus.publish('user-1', { type: 'invalidate', topic: SETTINGS_TOPIC });

    expect(received).toHaveLength(1);
  });

  it('is a no-op when no listeners are registered', () => {
    const bus = createRealtimeBus();
    expect(() =>
      bus.publish('nobody', { type: 'invalidate', topic: SETTINGS_TOPIC })
    ).not.toThrow();
  });

  it('continues fan-out when one listener throws', () => {
    const bus = createRealtimeBus();
    let okCalls = 0;
    const ok = mock(() => {
      okCalls += 1;
    });
    bus.subscribe('user-1', () => {
      throw new Error('boom');
    });
    bus.subscribe('user-1', ok);

    bus.publish('user-1', { type: 'invalidate', topic: SETTINGS_TOPIC });

    expect(ok).toHaveBeenCalledTimes(1);
    expect(okCalls).toBe(1);
  });

  it('continues fan-out when an async listener rejects', async () => {
    const bus = createRealtimeBus();
    let okCalls = 0;
    const ok = mock(() => {
      okCalls += 1;
    });
    bus.subscribe('user-1', async () => {
      await Promise.resolve();
      throw new Error('async boom');
    });
    bus.subscribe('user-1', ok);

    bus.publish('user-1', { type: 'invalidate', topic: SETTINGS_TOPIC });
    await Promise.resolve();

    expect(ok).toHaveBeenCalledTimes(1);
    expect(okCalls).toBe(1);
  });
});

describe('getRealtimeBus', () => {
  beforeEach(() => {
    setRealtimeBusForTests(undefined);
  });

  afterEach(() => {
    setRealtimeBusForTests(undefined);
    registerRealtimeBus();
  });

  it('returns a bus after registerApplicationServices wiring', () => {
    registerRealtimeBus();
    const bus = getRealtimeBus();
    const events: RealtimeInvalidateEvent[] = [];
    bus.subscribe('u', (event) => {
      events.push(event);
    });
    bus.publish('u', { type: 'invalidate', topic: SETTINGS_TOPIC });
    expect(events).toHaveLength(1);
  });
});
