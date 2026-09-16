/**
 * A child that refuses to leave: it ignores end of stdin and `SIGTERM`, so a
 * test can watch the launcher escalate to `SIGKILL`.
 *
 * It announces itself on stderr, never on stdout: stdout is the frame stream,
 * and one stray line there would be a protocol error rather than a slow exit.
 *
 * @example
 * bun tests/fixtures/stubborn-child.ts
 */

process.on('SIGTERM', () => {
  process.stderr.write('ignoring SIGTERM\n');
});

// Something has to hold the event loop open once stdin ends.
setInterval(() => undefined, 1000);

process.stderr.write('ready\n');
