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
import {
  GRANDCHILD_ENV,
  grandchildMarker,
  HANG_ENV,
  HEARTBEAT_MS,
  heartbeatPath,
  MARKER_ENV,
} from './fake-rustfmt-markers';

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
  JSON.stringify({
    args: process.argv.slice(2),
    cwd: process.cwd(),
    pid: process.pid,
    startedAt: performance.timeOrigin + performance.now(),
  })
);

if (hang) {
  let beat = 0;
  setInterval(
    () =>
      writeFileSync(
        heartbeatPath(marker),
        JSON.stringify({ beat: ++beat, at: performance.timeOrigin + performance.now() })
      ),
    HEARTBEAT_MS
  );
}
