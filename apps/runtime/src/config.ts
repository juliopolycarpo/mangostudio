import { homedir } from 'node:os';
import { mangoHomeDir } from '@mangostudio/shared/runtime-home';

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
  /** Absolute `~/.mango`; `MANGO_HOME` moves it, which is what tests use. */
  readonly mangoHome: string;
  /**
   * A consent answer supplied by the environment instead of by a person.
   *
   * It exists for images: a container is built once and started unattended, so
   * there is never a terminal to answer `setup` at. Left unvalidated here —
   * `setup` reports an unusable value rather than this silently ignoring it.
   */
  readonly setupProfile: string | null;
}

/** Runtime-owned environment parsing for the embedded and binary hosts. */
export function loadRuntimeConfig(
  env: Readonly<Record<string, string | undefined>> = process.env
): RuntimeConfig {
  const pairing = env.MANGOSTUDIO_RUNTIME_TOKEN?.trim();
  const serve = env.MANGOSTUDIO_RUNTIME_SERVE_TOKEN?.trim();
  const home = env.MANGO_HOME?.trim();
  const setupProfile = env.MANGOSTUDIO_RUNTIME_SETUP?.trim();
  return {
    // allow-node-env: enables frame validation outside production; this is a
    // production discriminator, not a test seam.
    validateInProcessFrames: env.NODE_ENV !== 'production',
    pairingToken: pairing && pairing.length > 0 ? pairing : null,
    serveToken: serve && serve.length > 0 ? serve : null,
    mangoHome: home && home.length > 0 ? home : mangoHomeDir(homedir(), process.platform),
    setupProfile: setupProfile && setupProfile.length > 0 ? setupProfile : null,
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
