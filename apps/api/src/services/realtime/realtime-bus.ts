/**
 * In-process, user-scoped pub/sub for realtime invalidation events.
 *
 * Single-process only: no persistence, replay, or cross-worker fan-out. A future
 * WebSocket layer subscribes per authenticated userId and filters by topic client-side.
 */
import type { RealtimeInvalidateEvent } from '@mangostudio/shared/realtime';
import { createDiagnosticLogger } from '../../lib/logger';

const logger = createDiagnosticLogger('realtime');

type RealtimeInvalidateListener = (event: RealtimeInvalidateEvent) => void;

type RealtimeUnsubscribe = () => void;

export interface RealtimeBus {
  publish(userId: string, event: RealtimeInvalidateEvent): void;
  subscribe(userId: string, listener: RealtimeInvalidateListener): RealtimeUnsubscribe;
}

export function createRealtimeBus(): RealtimeBus {
  const listenersByUser = new Map<string, Set<RealtimeInvalidateListener>>();

  function getOrCreateSet(userId: string): Set<RealtimeInvalidateListener> {
    let set = listenersByUser.get(userId);
    if (!set) {
      set = new Set();
      listenersByUser.set(userId, set);
    }
    return set;
  }

  return {
    publish(userId, event) {
      const listeners = listenersByUser.get(userId);
      if (!listeners || listeners.size === 0) {
        return;
      }
      for (const listener of listeners) {
        try {
          listener(event);
        } catch (error) {
          logger.error('listener_failed', {
            userId,
            topic: event.topic,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    },

    subscribe(userId, listener) {
      const set = getOrCreateSet(userId);
      set.add(listener);
      return () => {
        const current = listenersByUser.get(userId);
        if (!current) {
          return;
        }
        current.delete(listener);
        if (current.size === 0) {
          listenersByUser.delete(userId);
        }
      };
    },
  };
}

let busInstance: RealtimeBus | undefined;

/** Installs the process-wide bus (idempotent). */
export function registerRealtimeBus(): void {
  if (!busInstance) {
    busInstance = createRealtimeBus();
  }
}

export function getRealtimeBus(): RealtimeBus {
  if (!busInstance) {
    registerRealtimeBus();
  }
  return busInstance as RealtimeBus;
}

/** Test hook: replace or clear the singleton. */
export function setRealtimeBusForTests(bus: RealtimeBus | undefined): void {
  busInstance = bus;
}
