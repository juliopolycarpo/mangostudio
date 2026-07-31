/**
 * Lists the WSL distributions installed on the hub's own Windows host.
 *
 * This is a Windows fact, so it is answered hub-side rather than through a
 * runtime: the environments it describes do not exist yet. Every other platform
 * gets a typed "not windows" answer instead of a spawn that would fail with
 * ENOENT somewhere in the UI.
 */

import { execFile } from 'node:child_process';
import type { WslDetection, WslDistribution } from '@mangostudio/shared/environments';
import { createDiagnosticLogger } from '../../../lib/logger';
import { decodeWslOutput, parseWslDistributions } from '../domain/wsl-output';

const PROBE_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 1_024 * 1_024;

const logger = createDiagnosticLogger('wsl-detection');

interface WslProbeResult {
  readonly stdout: Uint8Array;
  readonly failed: boolean;
}

export interface WslDetectionDeps {
  readonly platform: NodeJS.Platform;
  readonly probe: () => Promise<WslProbeResult>;
}

export interface WslDetectionService {
  detect(): Promise<WslDetection>;
}

/**
 * `--list --verbose` is the only listing that carries state, version, and the
 * default marker at once. `WSL_UTF8` asks newer builds for UTF-8; older ones
 * ignore it and keep writing UTF-16LE, which the decoder handles either way.
 */
function probeWithWslExe(): Promise<WslProbeResult> {
  return new Promise((resolve) => {
    execFile(
      'wsl.exe',
      ['--list', '--verbose'],
      {
        encoding: 'buffer',
        timeout: PROBE_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
        env: { ...process.env, WSL_UTF8: '1' },
      },
      (error, stdout) => {
        // A non-zero exit is also how `wsl.exe` reports having no distributions
        // installed, so the output is parsed either way and only an empty
        // result plus a failure counts as a failure.
        resolve({ stdout: stdout ?? new Uint8Array(), failed: Boolean(error) });
      }
    );
  });
}

const defaultDeps: WslDetectionDeps = {
  platform: process.platform,
  probe: probeWithWslExe,
};

export function createWslDetectionService(
  overrides: Partial<WslDetectionDeps> = {}
): WslDetectionService {
  const deps = { ...defaultDeps, ...overrides };

  return {
    async detect(): Promise<WslDetection> {
      if (deps.platform !== 'win32') {
        return { available: false, distributions: [], reason: 'not-windows' };
      }

      const { stdout, failed } = await deps.probe();
      const distributions = parseWslDistributions(decodeWslOutput(stdout));
      if (distributions.length > 0) return { available: true, distributions };

      if (failed) {
        logger.warn('probe_failed', { bytes: stdout.byteLength });
        return { available: false, distributions: [], reason: 'wsl-not-installed' };
      }
      // wsl.exe ran and said nothing recognizable: it is installed, but there is
      // nothing to configure.
      return { available: true, distributions: [] };
    },
  };
}

export const wslDetectionService = createWslDetectionService();

/**
 * Marks the distributions an environment already points at, so the picker can
 * show them as configured instead of offering a duplicate.
 */
export function markConfiguredDistributions(
  distributions: readonly WslDistribution[],
  configured: ReadonlyMap<string, string>
): WslDistribution[] {
  return distributions.map((distribution) => {
    const environmentId = configured.get(distribution.name);
    return environmentId ? { ...distribution, environmentId } : distribution;
  });
}
