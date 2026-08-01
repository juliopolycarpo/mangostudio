export interface RuntimeConfig {
  /** Exercise the byte codec in-process so development catches wire drift. */
  readonly validateInProcessFrames: boolean;
  /**
   * Pairing token for `connect`, for setups that cannot pipe one in. Never a
   * command-line argument: argv is readable by every process on the machine.
   */
  readonly pairingToken: string | null;
}

/** Runtime-owned environment parsing for the embedded and binary hosts. */
export function loadRuntimeConfig(
  env: Readonly<Record<string, string | undefined>> = process.env
): RuntimeConfig {
  const token = env.MANGOSTUDIO_RUNTIME_TOKEN?.trim();
  return {
    validateInProcessFrames: env.NODE_ENV !== 'production',
    pairingToken: token && token.length > 0 ? token : null,
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
