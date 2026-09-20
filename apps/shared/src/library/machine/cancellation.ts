/**
 * Cooperative cancellation for the library write engines.
 *
 * Checked between operations rather than inside one. A single write is bounded
 * — one file, or one directory swap — while the fan-out across destinations is
 * where an apply spends a deadline's worth of time, so stopping at the boundary
 * is what makes a cancel arrive in time to matter. Each engine turns the throw
 * into its own failure shape, which routes it into the compensation path it
 * already has: the point of honouring the cancel is that the disk ends up
 * matching the failure the hub already reported to the user.
 */

class LibraryWriteCancelledError extends Error {
  constructor() {
    super('The library write was cancelled before this operation ran.');
    this.name = 'LibraryWriteCancelledError';
  }
}

export function assertNotCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new LibraryWriteCancelledError();
}
