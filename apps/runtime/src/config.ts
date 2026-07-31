export interface RuntimeConfig {
  /** Exercise the byte codec in-process so development catches wire drift. */
  readonly validateInProcessFrames: boolean;
  /** Stamped into the binary at build time; the handshake refuses a mismatch. */
  readonly runtimeVersion: string;
}

/** Runtime-owned environment parsing for the embedded and binary hosts. */
export function loadRuntimeConfig(
  env: Readonly<Record<string, string | undefined>> = process.env
): RuntimeConfig {
  return {
    validateInProcessFrames: env.NODE_ENV !== 'production',
    runtimeVersion: env.VERSION?.trim() || 'dev',
  };
}
