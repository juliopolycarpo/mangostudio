import type { ProcessGroupPort } from '../../ci/run-tests-watchdog';

export interface RecordedGroupSignal {
  readonly pid: number;
  readonly signal: NodeJS.Signals | 0;
}

export interface FakeProcessGroupBehaviour {
  /** Whether the group still has a member when probed with signal 0. */
  readonly aliveWhenProbed: boolean;
  /** The errno a real (non-zero) signal fails with; omitted when the kill lands. */
  readonly killFailsWith?: 'ESRCH' | 'EPERM';
}

const errnoError = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`kill ${code}`), { code });

/**
 * A named fake for the watchdog's process-group port: it records every signal
 * and answers from a fixed behaviour, and never touches a real process. A probe
 * on an empty group throws ESRCH, the answer for a leader that was reaped with
 * no member left, which is when the group id is free for the kernel to reuse.
 */
export class FakeProcessGroupPort implements ProcessGroupPort {
  readonly signals: RecordedGroupSignal[] = [];

  constructor(private readonly behaviour: FakeProcessGroupBehaviour) {}

  signalGroup(pid: number, signal: NodeJS.Signals | 0): void {
    this.signals.push({ pid, signal });
    if (signal === 0) {
      if (!this.behaviour.aliveWhenProbed) throw errnoError('ESRCH');
      return;
    }
    if (this.behaviour.killFailsWith) throw errnoError(this.behaviour.killFailsWith);
  }

  /** The signals that would have killed something, probes (`0`) excluded. */
  kills(): RecordedGroupSignal[] {
    return this.signals.filter((entry) => entry.signal !== 0);
  }
}
