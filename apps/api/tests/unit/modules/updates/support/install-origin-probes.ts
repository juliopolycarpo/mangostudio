/**
 * The `InstallOriginProbe` fixtures every upgrade test builds on. The probe is
 * the single input to origin detection, plan resolution and the engine, so it
 * gets one home here rather than a copy per test file — a field added to
 * `InstallOriginProbe` (as `localAppData` once was) is then one edit, not six,
 * and a copy that gets missed cannot silently keep testing a different install
 * shape.
 */

import type { InstallOriginProbe } from '../../../../../src/modules/updates/domain/install-origin';

export const PROBE_VERSION = '0.1.1';
const HOME = '/home/j';
const DIST_ROOT = `${HOME}/.mango/dist`;

/** A standalone binary under the default dist root, with no origin record on disk. */
export function probe(overrides: Partial<InstallOriginProbe> = {}): InstallOriginProbe {
  return {
    platform: 'linux',
    env: {},
    execPath: `${DIST_ROOT}/${PROBE_VERSION}/mangostudio`,
    version: PROBE_VERSION,
    standalone: true,
    container: false,
    home: HOME,
    readFile: () => null,
    ...overrides,
  };
}

/** The same install, plus the record the install script leaves two levels above the binary. */
export function selfManagedProbe(overrides: Partial<InstallOriginProbe> = {}): InstallOriginProbe {
  return probe({
    readFile: (path) =>
      path === `${DIST_ROOT}/install-origin.json`
        ? JSON.stringify({
            origin: 'installer',
            channel: 'stable',
            version: PROBE_VERSION,
            previousVersion: '0.1.0',
            binDir: `${HOME}/.local/bin`,
          })
        : null,
    ...overrides,
  });
}

/** A globally installed npm package — the delegate case. */
export function npmProbe(overrides: Partial<InstallOriginProbe> = {}): InstallOriginProbe {
  return probe({
    execPath: '/usr/local/lib/node_modules/mangostudio/bin/mangostudio.js',
    ...overrides,
  });
}

/**
 * A cargo install: the shim on PATH announces itself through the launcher
 * marker, so the origin records the shim's own path alongside the versioned
 * binary the shim actually exec'd.
 */
export function cargoProbe(overrides: Partial<InstallOriginProbe> = {}): InstallOriginProbe {
  return probe({
    env: {
      MANGOSTUDIO_LAUNCHER: 'cargo',
      MANGOSTUDIO_LAUNCHER_PATH: `${HOME}/.cargo/bin/mangostudio`,
    },
    ...overrides,
  });
}

/** Running inside a container, where no in-place upgrade applies at all. */
export function dockerProbe(overrides: Partial<InstallOriginProbe> = {}): InstallOriginProbe {
  return npmProbe({ execPath: '/usr/local/bin/mangostudio', container: true, ...overrides });
}
