import {
  ACTIVITY_TOPIC,
  RealtimeClientMessageSchema,
  RealtimeServerMessageSchema,
} from '@mangostudio/shared/realtime';
import type { Page } from '@playwright/test';
import { Value } from 'typebox/value';

const SUBSCRIBE_TIMEOUT_MS = 20_000;
const POLL_MS = 100;
const MAX_EVENTS = 24;

interface ProbeClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const clock: ProbeClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface RealtimeProbe {
  subscribed(label: string): Promise<void>;
  opened(): number;
  invalidations(): number;
}

/**
 * Watch a page's current realtime socket before navigation.
 * @example const probe = watchRealtime(page); await probe.subscribed('first tab');
 */
export function watchRealtime(
  page: Page,
  options: { clock?: ProbeClock; timeoutMs?: number } = {}
): RealtimeProbe {
  const time = options.clock ?? clock;
  const timeoutMs = options.timeoutMs ?? SUBSCRIBE_TIMEOUT_MS;
  let received = 0;
  let sockets = 0;
  let current: { socket: import('@playwright/test').WebSocket; ack: boolean } | undefined;
  const events: string[] = [];
  const record = (event: string) => {
    if (events.length === MAX_EVENTS) events.shift();
    events.push(event);
  };

  page.on('websocket', (socket) => {
    try {
      if (new URL(socket.url()).pathname !== '/api/ws') return;
    } catch {
      return;
    }
    sockets += 1;
    const connection = { socket, ack: false };
    current = connection;
    record('open');
    socket.on('close', () => {
      record(current === connection ? 'close:current' : 'close:old');
      if (current === connection) current = undefined;
    });
    socket.on('socketerror', () => record(current === connection ? 'error:current' : 'error:old'));
    const frame = (direction: 'send' | 'receive', payload: string | Buffer) => {
      let value: unknown;
      try {
        value = JSON.parse(typeof payload === 'string' ? payload : payload.toString('utf8'));
      } catch {
        record(`${direction}:invalid`);
        return;
      }
      const live = current === connection && !socket.isClosed();
      if (direction === 'send' && Value.Check(RealtimeClientMessageSchema, value)) {
        const activity = 'topics' in value && value.topics.includes(ACTIVITY_TOPIC);
        record(`send:${value.type}:${activity ? 'activity' : 'other'}:${live ? 'current' : 'old'}`);
        if (live && value.type === 'unsubscribe' && activity) connection.ack = false;
        return;
      }
      if (direction === 'receive' && Value.Check(RealtimeServerMessageSchema, value)) {
        const activity =
          value.type === 'subscribed'
            ? value.topics.includes(ACTIVITY_TOPIC)
            : value.type === 'invalidate' && value.topic === ACTIVITY_TOPIC;
        record(
          `receive:${value.type}:${activity ? 'activity' : 'other'}:${live ? 'current' : 'old'}`
        );
        if (!live || !activity) return;
        if (value.type === 'subscribed') connection.ack = true;
        if (value.type === 'invalidate') received += 1;
        return;
      }
      record(`${direction}:invalid`);
    };
    socket.on('framesent', ({ payload }) => frame('send', payload));
    socket.on('framereceived', ({ payload }) => frame('receive', payload));
  });

  return {
    async subscribed(label) {
      const deadline = time.now() + timeoutMs;
      while (!current || current.socket.isClosed() || !current.ack) {
        if (time.now() >= deadline) {
          throw new Error(
            `expected ${label} activity subscription ack within ${timeoutMs} ms | received: none (${sockets} realtime socket(s) opened; events: ${events.join(', ') || 'none'})`
          );
        }
        await time.sleep(POLL_MS);
      }
    },
    opened: () => sockets,
    invalidations: () => received,
  };
}
