// What the TypeScript protocol suite's pass stamp is keyed on. `bun run test`
// runs the suite in its unit phase; with every other unit lane restored from
// Turbo's cache it was the whole wall time of an unchanged run. Turbo cannot
// cache it without changing the command the native-Bun qualification inventory
// certifies, and a stamp leaves that command alone.

import { listCheckoutFiles } from './git';
import { PROTOCOL_PATHS } from './protocol';

/**
 * Files outside the protocol's own directories that decide what the suite
 * runs: the manifests and lockfile its dependencies resolve from, the Bun and
 * TypeScript configuration, the script library its launcher imports, and the
 * test support directory `bunfig.toml` preloads from.
 */
const PROTOCOL_TEST_HOST_INPUTS = [
  'package.json',
  'bun.lock',
  '.bun-version',
  'bunfig.toml',
  'tsconfig.json',
  'scripts/lib/**',
  'scripts/tests/support/**',
] as const;

/**
 * Every checkout file the TypeScript protocol suite's result depends on.
 *
 * @example
 * protocolTestInputFiles('/repo', ['spec/schema/1/protocol.json', 'apps/api/src/app.ts']);
 * // ['spec/schema/1/protocol.json']
 */
export function protocolTestInputFiles(
  rootDir: string,
  checkoutFiles: readonly string[] = listCheckoutFiles(rootDir)
): string[] {
  const hostGlobs = PROTOCOL_TEST_HOST_INPUTS.map((pattern) => new Bun.Glob(pattern));
  return checkoutFiles.filter(
    (file) =>
      PROTOCOL_PATHS.some((prefix) => file.startsWith(prefix)) ||
      hostGlobs.some((glob) => glob.match(file))
  );
}

/**
 * Variables a protocol test reads: `MANGO_INTEROP` turns the Rust-driven
 * suites on, `MANGO_TEST_*` change what a fixture prints or leaks, and
 * `XDG_RUNTIME_DIR` places the IPC sockets. Every other `MANGO*` name is kept
 * too, except `MANGO_RUNNER_GROUP`, which differs on every run.
 */
const PROTOCOL_TEST_ENV = /^(?:MANGO(?!_RUNNER_GROUP$).+|XDG_RUNTIME_DIR)$/;

/**
 * Everything but file bytes that the suite's result depends on: its command,
 * the Bun build, the host, and the caller's `MANGO*` variables.
 *
 * @example
 * protocolTestFacts(['bun', './scripts/protocol/test.ts', '--ts-only']).bun; // '1.4.4 a62cc285'
 */
export function protocolTestFacts(
  command: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env
): Record<string, string> {
  const selected = Object.entries(env)
    .filter(([name, value]) => PROTOCOL_TEST_ENV.test(name) && value !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : 1));
  return {
    command: JSON.stringify(command),
    bun: `${Bun.version} ${Bun.revision}`,
    host: `${process.platform} ${process.arch}`,
    env: JSON.stringify(selected),
  };
}
