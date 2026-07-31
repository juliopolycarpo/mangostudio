export interface RuntimeConfig {
  /** Exercise the byte codec in-process so development catches wire drift. */
  readonly validateInProcessFrames: boolean;
}

/** Runtime-owned environment parsing for the embedded and future binary hosts. */
export function loadRuntimeConfig(
  env: Readonly<Record<string, string | undefined>> = process.env
): RuntimeConfig {
  return {
    validateInProcessFrames: env.NODE_ENV !== 'production',
  };
}
