export interface RuntimeConfig {
  /** Exercise the byte codec in-process so development catches wire drift. */
  readonly validateInProcessFrames: boolean;
}

/** Runtime-owned environment parsing for the embedded and binary hosts. */
export function loadRuntimeConfig(
  env: Readonly<Record<string, string | undefined>> = process.env
): RuntimeConfig {
  return {
    validateInProcessFrames: env.NODE_ENV !== 'production',
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
