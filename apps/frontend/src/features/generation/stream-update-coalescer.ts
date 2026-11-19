import type { Message } from '@mangostudio/shared/chat';

/** One patch for one cached message, as the stream reducer produces it. */
export interface StreamUpdate {
  readonly targetMessageId: string;
  readonly patch: Partial<Message>;
}

/** Runs `callback` once, on the next display frame; returns what cancels it. */
export interface FrameScheduler {
  schedule(callback: () => void): () => void;
}

/**
 * How long a frame callback may be late before a timer runs it instead. A hidden tab
 * pauses `requestAnimationFrame` altogether, and a stream that keeps arriving there must
 * still reach the cache.
 */
const FRAME_FALLBACK_MS = 100;

/** The browser's next frame, or {@link FRAME_FALLBACK_MS} later when frames are paused. */
export const animationFrameScheduler: FrameScheduler = {
  schedule(callback) {
    let finished = false;
    const finish = (run: boolean) => {
      if (finished) return;
      finished = true;
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      if (run) callback();
    };
    const frame = requestAnimationFrame(() => finish(true));
    const timer = setTimeout(() => finish(true), FRAME_FALLBACK_MS);
    return () => finish(false);
  },
};

/**
 * Caps how often a streamed text delta is written to the transcript cache at once per
 * display frame (at most one write per frame, after the first).
 *
 * Every write to the cache re-renders the transcript, and a provider that streams faster
 * than the display refreshes (a delta every few milliseconds) paid for each one: the work
 * of a frame, several times over, for a screen that can show only the last. The first
 * update of a quiet stretch is applied at once, so a slow stream sees no added delay; the
 * ones that follow within the frame are held and merged, and the frame applies the result.
 * Patches carry the whole text so far, so the merged patch is the newest one.
 *
 * Only deltas belong here. A caller flushes before it applies anything else (a tool call,
 * the terminal chunk, a message id swap), so the cache never sees updates out of order.
 *
 * Usage: const coalescer = new StreamUpdateCoalescer((u) => write(u));
 *        coalescer.push(update); // a delta
 *        coalescer.flush(); // before any other write, and when the stream ends
 */
export class StreamUpdateCoalescer {
  readonly #apply: (update: StreamUpdate) => void;
  readonly #scheduler: FrameScheduler;
  #held: StreamUpdate | null = null;
  #cancelFrame: (() => void) | null = null;

  constructor(
    apply: (update: StreamUpdate) => void,
    scheduler: FrameScheduler = animationFrameScheduler
  ) {
    this.#apply = apply;
    this.#scheduler = scheduler;
  }

  /** Applies `update` now when the frame is quiet; otherwise holds it for the frame. */
  push(update: StreamUpdate): void {
    if (this.#cancelFrame === null) {
      this.#apply(update);
      this.#openFrame();
      return;
    }
    const held = this.#held;
    if (held?.targetMessageId === update.targetMessageId) {
      this.#held = {
        targetMessageId: held.targetMessageId,
        patch: { ...held.patch, ...update.patch },
      };
      return;
    }
    // A different message: the held one is older, and goes first.
    this.flush();
    this.#held = update;
  }

  /** Applies what is held, without waiting for the frame. */
  flush(): void {
    const held = this.#held;
    if (!held) return;
    this.#held = null;
    this.#apply(held);
  }

  /** Cancels the pending frame. Flush first: anything still held is dropped with it. */
  dispose(): void {
    this.#cancelFrame?.();
    this.#cancelFrame = null;
    this.#held = null;
  }

  #openFrame(): void {
    this.#cancelFrame = this.#scheduler.schedule(() => {
      this.#cancelFrame = null;
      if (!this.#held) return;
      this.flush();
      // Something was applied, so the next update is held for the following frame:
      // one write per frame while the stream keeps up.
      this.#openFrame();
    });
  }
}
