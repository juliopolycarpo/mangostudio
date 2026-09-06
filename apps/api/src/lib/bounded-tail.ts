/**
 * Rolling tail buffer for child-process output. A crashing child can be very
 * chatty, so diagnostics keep the end of the stream rather than all of it.
 */

/** Appends a chunk to a rolling buffer, keeping at most maxChars of the tail. */
export function appendBoundedTail(existing: string, chunk: string, maxChars: number): string {
  const combined = existing + chunk;
  return combined.length > maxChars ? combined.slice(-maxChars) : combined;
}
