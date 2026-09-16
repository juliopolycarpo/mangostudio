import { decodeLine, encodeFrameBytes, resolveFrameLimit } from '../codec/ndjson';
import { Listeners } from '../listeners';
import type { Port, PortClosure } from '../port';
import { assertFrame, type Frame } from '../schemas/frames';

export interface InProcessOptions {
  /**
   * Round-trip every frame through the byte codec so an embedded peer cannot
   * exchange a value a remote transport would lose. On by default; production
   * embeddings may turn it off and keep the structural clone plus schema check.
   */
  readonly validateFrames?: boolean;
  /** Largest frame the pair's codec accepts; the 16 MiB default of §11 when absent. */
  readonly maxFrameBytes?: number;
}

export interface InProcessPortPair {
  readonly a: Port;
  readonly b: Port;
}

/**
 * Two ports connected back to back inside one process, delivering in FIFO
 * order on a later microtask.
 *
 * @example
 * const { a, b } = createInProcessPortPair();
 * const hub = new Session(a, { peer: { name: 'hub', version: '1', role: 'hub' } });
 * const runtime = new Session(b, { peer: { name: 'runtime', version: '1', role: 'runtime' } });
 */
export function createInProcessPortPair(options: InProcessOptions = {}): InProcessPortPair {
  const a = new InProcessPort(options);
  const b = new InProcessPort(options);
  a.connect(b);
  b.connect(a);
  return { a, b };
}

class InProcessPort implements Port {
  readonly maxFrameBytes: number;
  readonly #frames = new Listeners<Frame>();
  readonly #closed = new Listeners<PortClosure>();
  readonly #options: InProcessOptions;
  #peer?: InProcessPort;
  #open = true;

  constructor(options: InProcessOptions) {
    this.#options = options;
    this.maxFrameBytes = resolveFrameLimit(options);
  }

  connect(peer: InProcessPort): void {
    this.#peer = peer;
  }

  /** True until this side or its peer closed. */
  get isOpen(): boolean {
    return this.#open;
  }

  send(frame: Frame): void {
    const peer = this.#peer;
    if (!this.#open || !peer?.isOpen) {
      throw new Error(
        'In-process port is closed; expected an open port pair, received a closed one.'
      );
    }
    const delivered = this.#clone(frame);
    queueMicrotask(() => {
      if (!peer.#open) return;
      peer.#frames.emit(delivered);
    });
  }

  onFrame(listener: (frame: Frame) => void): () => void {
    return this.#frames.add(listener);
  }

  onClosed(listener: (closure: PortClosure) => void): () => void {
    return this.#closed.add(listener);
  }

  close(code: number, reason?: string): void {
    if (!this.#open) return;
    this.#dispose();
    const peer = this.#peer;
    if (!peer?.isOpen) return;
    queueMicrotask(() => {
      if (!peer.#open) return;
      peer.#dispose();
      peer.#closed.emit({ kind: 'closed', code, ...(reason !== undefined ? { reason } : {}) });
      peer.#closed.clear();
    });
  }

  #dispose(): void {
    this.#open = false;
    this.#frames.clear();
  }

  #clone(frame: Frame): Frame {
    if (this.#options.validateFrames ?? true) {
      const bytes = encodeFrameBytes(frame, this.#options);
      return decodeLine(bytes, this.#options);
    }
    const cloned: unknown = structuredClone(frame);
    assertFrame(cloned);
    return cloned;
  }
}
