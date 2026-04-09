/**
 * Supplementary error types that complement the contracts defined in index.ts.
 */

/** SSE error event emitted by streaming endpoints when generation fails. */
export interface SSEErrorEvent {
  type: 'error';
  error: string;
  done: true;
}
