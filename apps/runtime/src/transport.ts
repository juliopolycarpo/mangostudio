import {
  assertRuntimeFrame,
  decodeRuntimeFrameLine,
  encodeRuntimeFrame,
  type RuntimeFrame,
} from '@mangostudio/shared/runtime-protocol';

export interface RuntimeFramePort {
  send(frame: RuntimeFrame): void;
  onFrame(listener: (frame: RuntimeFrame) => void): () => void;
  close(): void;
}

export interface InProcessPortPair {
  readonly hub: RuntimeFramePort;
  readonly runtime: RuntimeFramePort;
}

/**
 * Creates FIFO in-memory ports. Validation mode round-trips each frame through
 * the byte codec so embedded execution cannot rely on values a remote transport
 * would lose.
 */
export function createInProcessPortPair(options: {
  readonly validateFrames: boolean;
}): InProcessPortPair {
  const hub = new InProcessFramePort(options.validateFrames);
  const runtime = new InProcessFramePort(options.validateFrames);
  hub.connect(runtime);
  runtime.connect(hub);
  return { hub, runtime };
}

class InProcessFramePort implements RuntimeFramePort {
  readonly #listeners = new Set<(frame: RuntimeFrame) => void>();
  readonly #validateFrames: boolean;
  #closed = false;
  #peer?: InProcessFramePort;

  constructor(validateFrames: boolean) {
    this.#validateFrames = validateFrames;
  }

  connect(peer: InProcessFramePort): void {
    this.#peer = peer;
  }

  send(frame: RuntimeFrame): void {
    if (this.#closed || !this.#peer || this.#peer.#closed) {
      throw new Error('Runtime in-process port is closed.');
    }
    const delivered = cloneFrame(frame, this.#validateFrames);
    const peer = this.#peer;
    queueMicrotask(() => {
      if (!peer || peer.#closed) return;
      for (const listener of peer.#listeners) listener(delivered);
    });
  }

  onFrame(listener: (frame: RuntimeFrame) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  close(): void {
    this.#closed = true;
    this.#listeners.clear();
  }
}

function cloneFrame(frame: RuntimeFrame, validateFrames: boolean): RuntimeFrame {
  if (validateFrames) {
    const encoded = encodeRuntimeFrame(frame);
    return decodeRuntimeFrameLine(encoded.slice(0, -1));
  }

  const cloned = structuredClone(frame);
  assertRuntimeFrame(cloned);
  return cloned;
}
