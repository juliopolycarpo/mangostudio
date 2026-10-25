/**
 * What `agent-hooks.unit.test.ts` and the fake rustfmt (`fake-rustfmt.ts`) share: the
 * environment the test sets and the files the fake writes.
 *
 * The fake's entrypoint stays apart from these exports, so it runs its body unconditionally
 * instead of behind an `import.meta.main` guard that a compiled Windows executable can fail.
 */

export const MARKER_ENV = 'MANGO_TEST_RUSTFMT_MARKER';
export const HANG_ENV = 'MANGO_TEST_RUSTFMT_HANG';
export const QUIET_ENV = 'MANGO_TEST_RUSTFMT_QUIET';
export const CONTROL_ENV = 'MANGO_TEST_RUSTFMT_CONTROL';
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
 * A stop request addressed to this fake's unique marker rather than its pid.
 * @example
 * stopPath('/tmp/started.json'); // '/tmp/started.json.stop'
 */
export function stopPath(marker: string): string {
  return `${marker}.stop`;
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

/** Address one event in the controlled formatter lifecycle. @example formatterControlPath(marker, 'spawn-release'); */
export function formatterControlPath(marker: string, event: string): string {
  return `${marker}.${event}`;
}
