/**
 * Supplementary error types that complement the contracts defined in index.ts.
 */

/** SSE error event emitted by streaming endpoints when generation fails. */
export interface SSEErrorEvent {
  error: string;
  done: true;
}
