import type { CodecError } from './errors';
import type { Frame } from './schemas/frames';

/**
 * Why a port stopped delivering frames.
 *
 * `closed` is the transport ending: end of file, a socket close (with the
 * peer's close code when the transport carries one), a broken pipe. It is
 * never a protocol violation. `protocol-error` is a record the codec refused;
 * the stream cannot be resynchronised after one, so the port closes with the
 * code it reports here (`4400`, or `4426` for a hello nobody could read).
 */
export type PortClosure =
  | { readonly kind: 'closed'; readonly code?: number; readonly reason?: string }
  | { readonly kind: 'protocol-error'; readonly error: CodecError; readonly code: number };

/**
 * One end of a transport, as the session sees it: whole frames in, whole
 * frames out, and one notification when the far side is gone.
 *
 * Every transport in the SDK produces a `Port`; the session never learns which
 * one. A port owns the codec for its transport and enforces the frame limit on
 * what it decodes; the session enforces the negotiated limit on what it sends.
 *
 * @example
 * const port = createInProcessPortPair().a;
 * const off = port.onFrame((frame) => console.warn(frame.type));
 * port.send({ type: 'ping' });
 * off();
 */
export interface Port {
  /**
   * Largest frame this port's decoder accepts, when the transport enforces
   * one. A session announces it in `hello.limits` so one number governs
   * what is refused on arrival and what the peer is told to send.
   */
  readonly maxFrameBytes?: number;
  /** Sends one frame. Throws when the port is closed or the frame cannot be encoded. */
  send(frame: Frame): void;
  /** Subscribes to decoded frames. Returns the unsubscribe function. */
  onFrame(listener: (frame: Frame) => void): () => void;
  /** Fires at most once, and never for an owner-initiated `close()`. */
  onClosed(listener: (closure: PortClosure) => void): () => void;
  /**
   * Closes the transport with a reason code from the `4000–4999` table. A
   * transport without a close code of its own sends a `close` frame first.
   */
  close(code: number, reason?: string): void;
}
