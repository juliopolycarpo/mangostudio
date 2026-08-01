export interface RuntimeConfig {
  /** Exercise the byte codec in-process so development catches wire drift. */
  readonly validateInProcessFrames: boolean;
  /**
   * Pairing token for `connect`, for setups that cannot pipe one in. Never a
   * command-line argument: argv is readable by every process on the machine.
   */
  readonly pairingToken: string | null;
  /**
   * Serve token for `serve`, for setups that inject it per run. Distinct from
   * `pairingToken` so a machine that both dials and listens does not reuse one
   * credential for two trust decisions.
   */
  readonly serveToken: string | null;
}

/** Runtime-owned environment parsing for the embedded and binary hosts. */
export function loadRuntimeConfig(
  env: Readonly<Record<string, string | undefined>> = process.env
): RuntimeConfig {
  const pairing = env.MANGOSTUDIO_RUNTIME_TOKEN?.trim();
  const serve = env.MANGOSTUDIO_RUNTIME_SERVE_TOKEN?.trim();
  return {
    validateInProcessFrames: env.NODE_ENV !== 'production',
    pairingToken: pairing && pairing.length > 0 ? pairing : null,
    serveToken: serve && serve.length > 0 ? serve : null,
  };
}

/**
 * Version the handshake announces; the hub refuses a mismatch with its own.
 *
 * The compiled binary gets this from `--define process.env.VERSION`, which only
 * substitutes a literal `process.env` access — so this deliberately does not
 * read through an injected environment record the way `loadRuntimeConfig` does.
 */
export function getRuntimeVersion(): string {
  return process.env.VERSION || 'dev';
}
