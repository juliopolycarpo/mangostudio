/**
 * A backoff sleep a test controls: it records every wait and resolves it
 * either on the next macrotask (`auto`) or only when the test calls
 * `advance()`. An abort always resolves a pending wait, exactly like the
 * production `sleepUnlessAborted`.
 */

import type { CancellableSleep } from '../../../src/modules/external-agents/application/external-turn-submission';

export interface FakeBackoffClock {
  readonly sleep: CancellableSleep;
  /** Every requested wait, in milliseconds, in order. */
  readonly waits: number[];
  /** Waits requested but not yet resolved. */
  pendingCount(): number;
  /** Resolves every pending wait. */
  advance(): void;
  /** Runs after each wait is requested, before it can resolve. */
  onWait(listener: (count: number) => void): void;
}

export function createFakeBackoffClock(options: { readonly auto: boolean }): FakeBackoffClock {
  const waits: number[] = [];
  const pending = new Set<() => void>();
  let listener: ((count: number) => void) | undefined;
  return {
    waits,
    sleep(ms, signal) {
      waits.push(ms);
      listener?.(waits.length);
      return new Promise<void>((resolve) => {
        const done = () => {
          pending.delete(done);
          signal.removeEventListener('abort', done);
          resolve();
        };
        if (signal.aborted) return done();
        signal.addEventListener('abort', done, { once: true });
        pending.add(done);
        if (options.auto) setTimeout(done, 0);
      });
    },
    pendingCount: () => pending.size,
    advance() {
      for (const done of [...pending]) done();
    },
    onWait(next) {
      listener = next;
    },
  };
}
