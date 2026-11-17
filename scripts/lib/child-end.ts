/** The two fields of a Bun child process that say it has stopped. */
export interface ChildEndState {
  readonly exitCode: number | null;
  readonly signalCode: string | number | null;
}

/**
 * How a child ended, or null while it runs. A child killed by a signal keeps `exitCode === null`
 * and sets `signalCode`, so a readiness loop that tests the exit code alone spins until its
 * deadline on a dead hub and reports a timeout.
 * Example: childEnd({ exitCode: null, signalCode: 'SIGKILL' }) // 'signal SIGKILL'
 */
export function childEnd(child: ChildEndState): string | null {
  if (child.exitCode !== null) return `exit ${child.exitCode}`;
  if (child.signalCode !== null) return `signal ${child.signalCode}`;
  return null;
}
