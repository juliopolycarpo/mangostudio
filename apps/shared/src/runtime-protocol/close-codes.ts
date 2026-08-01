/**
 * Close codes the hub uses on `/api/runtime`.
 *
 * A dialing runtime has no response body to read, so the close code is the only
 * thing that distinguishes "your credential is gone, stop trying" from "come
 * back in a moment". Reconnect behaviour is decided from these, which is why
 * they are shared rather than restated on each side.
 *
 * 4000–4999 is the range reserved for application use. These are deliberately
 * separate from `REALTIME_CLOSE_CODES`: the browser bus and this endpoint have
 * different peers, different credentials, and no shared vocabulary to keep in
 * step.
 */
export const RUNTIME_CLOSE_CODES = {
  /** Missing, malformed, unknown, or revoked pairing token. */
  UNAUTHORIZED: 4401,
  /** The token is valid but its environment is disabled or no longer exists. */
  FORBIDDEN: 4403,
  /** Another connection for this environment took over. */
  SUPERSEDED: 4409,
  /** Too many upgrades from this address. Back off further than usual. */
  RATE_LIMITED: 4429,
  /** A frame or chunk the codec refused; the stream cannot be resynchronised. */
  PROTOCOL_ERROR: 4400,
  /** The hub failed while setting the connection up. */
  INTERNAL: 4500,
  /** The hub let the connection go — a disconnect, a rotation, or shutdown. */
  RELEASED: 4000,
} as const;

export type RuntimeCloseCode = (typeof RUNTIME_CLOSE_CODES)[keyof typeof RUNTIME_CLOSE_CODES];

/**
 * True when redialing cannot change the outcome. The runtime stops and says
 * what to fix instead of retrying into a wall — the failure is a credential or
 * a configuration decision, and only a person can move either.
 */
export function isFatalRuntimeCloseCode(code: number): boolean {
  return code === RUNTIME_CLOSE_CODES.UNAUTHORIZED || code === RUNTIME_CLOSE_CODES.FORBIDDEN;
}
