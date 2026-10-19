/**
 * A stand-in for `rustfmt`, compiled by `agent-hooks.unit.test.ts` into a native
 * executable so the hook's real `PATH` lookup finds it on Windows too.
 *
 * It records its argv, cwd and pid in the marker file the test names. In hang
 * mode it first starts one copy of itself, the way a rustup proxy starts the
 * real formatter, then both write an increasing heartbeat until they are
 * stopped, so a test can tell a stopped process from a reused pid.
 *
 * @example
 * MANGO_TEST_RUSTFMT_MARKER=/tmp/started.json MANGO_TEST_RUSTFMT_HANG=1 rustfmt src/lib.rs
 */
import { writeFileSync } from 'node:fs';

export const MARKER_ENV = 'MANGO_TEST_RUSTFMT_MARKER';
export const HANG_ENV = 'MANGO_TEST_RUSTFMT_HANG';
/** Set on the copy a hanging fake starts; the copy hangs without starting another. */
export const GRANDCHILD_ENV = 'MANGO_TEST_RUSTFMT_GRANDCHILD';
export const HEARTBEAT_MS = 50;

/**
 * The heartbeat file beside a marker.
 *
 * @example
 * heartbeatPath('/tmp/started.json'); // '/tmp/started.json.beat'
 */
export function heartbeatPath(marker: string): string {
  return `${marker}.beat`;
}

/**
 * The marker of the copy a hanging fake starts.
 *
 * @example
 * grandchildMarker('/tmp/started.json'); // '/tmp/started.json.grandchild'
 */
export function grandchildMarker(marker: string): string {
  return `${marker}.grandchild`;
}

if (import.meta.main) {
  const marker = process.env[MARKER_ENV];
  if (!marker) {
    throw new Error(
      `fake rustfmt (${MARKER_ENV}): expected a marker file path | received: ${JSON.stringify(marker)}`
    );
  }
  const hang = process.env[HANG_ENV] === '1';

  if (hang && process.env[GRANDCHILD_ENV] !== '1') {
    Bun.spawn([process.execPath, ...process.argv.slice(2)], {
      env: { ...process.env, [MARKER_ENV]: grandchildMarker(marker), [GRANDCHILD_ENV]: '1' },
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
    });
  }
  writeFileSync(
    marker,
    JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), pid: process.pid })
  );

  if (hang) {
    let beat = 0;
    setInterval(() => writeFileSync(heartbeatPath(marker), String(++beat)), HEARTBEAT_MS);
  }
}
