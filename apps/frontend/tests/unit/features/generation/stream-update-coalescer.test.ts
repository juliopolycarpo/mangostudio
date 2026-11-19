import { describe, expect, it } from 'bun:test';

import {
  animationFrameScheduler,
  type FrameScheduler,
  type StreamUpdate,
  StreamUpdateCoalescer,
} from '../../../../src/features/generation/stream-update-coalescer';

/** A scheduler the test steps by hand: `runFrame()` is the browser reaching its next frame. */
class ManualFrameScheduler implements FrameScheduler {
  #callbacks = new Map<number, () => void>();
  #nextId = 0;

  get pendingFrames(): number {
    return this.#callbacks.size;
  }

  schedule(callback: () => void): () => void {
    const id = this.#nextId++;
    this.#callbacks.set(id, callback);
    return () => {
      this.#callbacks.delete(id);
    };
  }

  runFrame(): void {
    const due = [...this.#callbacks.values()];
    this.#callbacks.clear();
    for (const callback of due) callback();
  }
}

function update(targetMessageId: string, text: string): StreamUpdate {
  return { targetMessageId, patch: { text } };
}

function setup() {
  const frames = new ManualFrameScheduler();
  const applied: StreamUpdate[] = [];
  const coalescer = new StreamUpdateCoalescer((next) => applied.push(next), frames);
  return { frames, applied, coalescer };
}

const texts = (applied: readonly StreamUpdate[]) => applied.map((next) => next.patch.text);

describe('StreamUpdateCoalescer', () => {
  it('applies the first update at once, so a stream slower than the display adds no delay', () => {
    const { applied, coalescer } = setup();

    coalescer.push(update('ai-1', 'a'));

    expect(texts(applied)).toEqual(['a']);
  });

  it('holds the updates that arrive before the next frame and applies only the newest one in it', () => {
    const { frames, applied, coalescer } = setup();

    coalescer.push(update('ai-1', 'a'));
    coalescer.push(update('ai-1', 'ab'));
    coalescer.push(update('ai-1', 'abc'));
    expect(texts(applied)).toEqual(['a']);

    frames.runFrame();

    expect(texts(applied)).toEqual(['a', 'abc']);
  });

  it('merges held patches key by key, so a later patch never drops a field an earlier one set', () => {
    const { frames, applied, coalescer } = setup();

    coalescer.push(update('ai-1', 'a'));
    coalescer.push({ targetMessageId: 'ai-1', patch: { text: 'ab' } });
    coalescer.push({ targetMessageId: 'ai-1', patch: { isGenerating: true } });
    frames.runFrame();

    expect(applied.at(-1)?.patch).toEqual({ text: 'ab', isGenerating: true });
  });

  it('applies at most one update per frame while the stream keeps going', () => {
    const { frames, applied, coalescer } = setup();

    coalescer.push(update('ai-1', 'a'));
    coalescer.push(update('ai-1', 'ab'));
    frames.runFrame();
    // Right after a frame that applied something, the next update is held for the following frame.
    coalescer.push(update('ai-1', 'abc'));
    expect(texts(applied)).toEqual(['a', 'ab']);

    frames.runFrame();
    expect(texts(applied)).toEqual(['a', 'ab', 'abc']);
  });

  it('applies the next update at once again after a frame with nothing held', () => {
    const { frames, applied, coalescer } = setup();

    coalescer.push(update('ai-1', 'a'));
    frames.runFrame();
    expect(frames.pendingFrames).toBe(0);

    coalescer.push(update('ai-1', 'ab'));

    expect(texts(applied)).toEqual(['a', 'ab']);
  });

  it('applies a held update before one for another message, in arrival order', () => {
    const { applied, coalescer } = setup();

    coalescer.push(update('ai-1', 'a'));
    coalescer.push(update('ai-1', 'ab'));
    coalescer.push(update('ai-2', 'x'));

    expect(applied.map((next) => [next.targetMessageId, next.patch.text])).toEqual([
      ['ai-1', 'a'],
      ['ai-1', 'ab'],
    ]);

    coalescer.flush();

    expect(applied.map((next) => [next.targetMessageId, next.patch.text])).toEqual([
      ['ai-1', 'a'],
      ['ai-1', 'ab'],
      ['ai-2', 'x'],
    ]);
  });

  it('flush applies the held update at once and leaves nothing for the next frame', () => {
    const { frames, applied, coalescer } = setup();

    coalescer.push(update('ai-1', 'a'));
    coalescer.push(update('ai-1', 'ab'));
    coalescer.flush();
    expect(texts(applied)).toEqual(['a', 'ab']);

    frames.runFrame();
    expect(texts(applied)).toEqual(['a', 'ab']);
  });

  it('flush with nothing held applies nothing', () => {
    const { applied, coalescer } = setup();

    coalescer.flush();
    coalescer.push(update('ai-1', 'a'));
    coalescer.flush();

    expect(texts(applied)).toEqual(['a']);
  });

  it('dispose cancels the scheduled frame', () => {
    const { frames, coalescer } = setup();

    coalescer.push(update('ai-1', 'a'));
    expect(frames.pendingFrames).toBe(1);

    coalescer.dispose();

    expect(frames.pendingFrames).toBe(0);
  });
});

describe('animationFrameScheduler', () => {
  it('runs the callback once on the frame, or on the timer fallback when frames are paused', async () => {
    let runs = 0;
    animationFrameScheduler.schedule(() => {
      runs += 1;
    });

    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(runs).toBe(1);
  });

  it('does not run a cancelled callback', async () => {
    let runs = 0;
    const cancel = animationFrameScheduler.schedule(() => {
      runs += 1;
    });
    cancel();

    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(runs).toBe(0);
  });
});
