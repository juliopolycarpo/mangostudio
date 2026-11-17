/**
 * The refusal every environment service speaks.
 *
 * It lives in the domain rather than beside one service because more than one
 * of them raises it, and routing it through whichever service happened to
 * declare it first is what turns a shared vocabulary into an import cycle.
 */

/** Why a refusal happened, in the classes a client can act on. Sent as `details.reason`. */
export type EnvironmentServiceFailureReason =
  /** The hub could not remove the runtime bytes from the machine. */
  | 'runtime-removal-failed'
  /** The per-environment token edit lock is held by something else. */
  | 'token-edit-locked'
  /** The hub could not store the runtime token. */
  | 'token-storage-failed'
  /** The environment could not be reached to connect it. */
  | 'connect-failed'
  /** The installed runtimes could not be probed to validate a toolchain pin. */
  | 'toolchain-probe-failed';

export interface EnvironmentServiceErrorOptions {
  /** Stable machine-readable class; sent to the client as `details.reason`. */
  readonly reason?: EnvironmentServiceFailureReason;
  /**
   * The raw text behind the refusal: stderr, a thrown error's message, a path.
   * Hub-side only. The route logs it with `environmentId` and never sends it.
   */
  readonly diagnostic?: string;
  /** The environment the refusal is about, for the hub log line. */
  readonly environmentId?: string;
}

/**
 * `message` is what an HTTP client is told, so it is fixed text that says what
 * failed and what the user can do. Anything raw goes in `options.diagnostic`.
 *
 * @example
 * throw new EnvironmentServiceError('The environment could not be connected.', 409, {
 *   reason: 'connect-failed',
 *   diagnostic: String(error),
 *   environmentId: id,
 * });
 */
export class EnvironmentServiceError extends Error {
  readonly reason?: EnvironmentServiceFailureReason;
  readonly diagnostic?: string;
  readonly environmentId?: string;

  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 422 | 503,
    options: EnvironmentServiceErrorOptions = {}
  ) {
    super(message);
    this.name = 'EnvironmentServiceError';
    if (options.reason !== undefined) this.reason = options.reason;
    if (options.diagnostic !== undefined) this.diagnostic = options.diagnostic;
    if (options.environmentId !== undefined) this.environmentId = options.environmentId;
  }
}

/** The text of whatever was thrown, for an error's `diagnostic`. */
export function diagnosticOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
