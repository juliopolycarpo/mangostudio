/**
 * One shape for "there is no model to run this on", wherever it is caught.
 *
 * `NoModelAvailableError` reaches HTTP from eight places — the streaming turn,
 * the non-streaming respond route, capability inspection, title generation,
 * compaction, summarize-to-new-chat, image generation and commit messages. Each
 * one used to spell its own 503, which was fine while the answer was a single
 * sentence and stopped being fine the moment the refusal had to carry an action
 * the client renders. A second copy of that mapping is a second place for a
 * refusal to arrive without its migration path.
 */

import { type ApiErrorResponse, ERROR_CODES } from '@mangostudio/shared/errors';
import type { NoModelAvailableError } from '../application/resolve-model';

export interface ModelUnavailableHttpResponse {
  readonly status: number;
  readonly body: ApiErrorResponse;
}

/**
 * Maps a model-resolution failure to its HTTP answer.
 * // Usage: const { status, body } = modelUnavailableResponse(err); set.status = status; return body;
 */
export function modelUnavailableResponse(
  error: NoModelAvailableError
): ModelUnavailableHttpResponse {
  const deprecated = error.details.reason === 'provider-deprecated';
  return {
    // Both arms are 503: in both, the request is well-formed and the server has
    // no model to serve it with. What separates them is the code and the
    // details, which is what the client branches on.
    status: 503,
    body: {
      error: error.message,
      code: deprecated ? ERROR_CODES.MODEL_PROVIDER_DEPRECATED : ERROR_CODES.PROVIDER_ERROR,
      // `details` is a string map on the wire and every field here is a string,
      // so the typed contract travels without widening the error envelope.
      ...(deprecated ? { details: { ...error.details } } : {}),
    },
  };
}
