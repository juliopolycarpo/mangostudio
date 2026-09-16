/**
 * A conforming stdio peer, for the tests that need a real child process: it
 * speaks the protocol on stdin and stdout and serves the conformance handlers.
 *
 * `MANGO_TEST_STDERR` is written to stderr before the handshake, so a launcher
 * test can prove the stderr tail is captured.
 *
 * @example
 * bun tests/fixtures/stdio-echo.ts
 */

import { Session } from '../../src/session';
import { CONFORMANCE_HANDLERS } from '../../src/testing/conformance';
import { stdioPort } from '../../src/transports/stdio';

const diagnostic = process.env.MANGO_TEST_STDERR;
if (diagnostic !== undefined && diagnostic.length > 0) process.stderr.write(diagnostic);

// Nothing keeps this process alive once the port releases the standard
// streams, so the child exits on its own when the session ends. It must not
// call `process.exit`: a piped stdout is asynchronous on Windows, and exiting
// would truncate the `close` frame this peer still owes its launcher.
new Session(stdioPort(), {
  peer: { name: 'stdio-echo', version: '0.1.0', role: 'tool' },
  handlers: CONFORMANCE_HANDLERS,
  livenessIntervalMs: false,
});
