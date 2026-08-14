/**
 * One reader for both error representations.
 *
 * Clients should never branch on which representation they got. Everything that
 * consumes a failed MangoStudio response — the frontend's `ApiError`, external
 * clients, tests — goes through this function, so adding problem details did
 * not add a second parsing path anywhere.
 */

import { isGeneratedProblemTitle } from './problem-details';
import type { ApiErrorResponse, ProblemDetails } from './schemas';

/** What a caller can rely on after reading any MangoStudio error body. */
export interface NormalizedApiError {
  /** Best human-readable text, or `null` when the body carried none. */
  message: string | null;
  /** MangoStudio's machine-readable code, identical in both representations. */
  code: string | null;
  /** Field-level failures, when the endpoint reports them. */
  details: Readonly<Record<string, string>> | null;
  /** The problem type URI; `null` for legacy bodies, which have no type. */
  type: string | null;
  /** The problem title; `null` for legacy bodies, which have no title. */
  title: string | null;
  /** True when the body was RFC 9457 rather than the legacy shape. */
  problemDetails: boolean;
}

const EMPTY: NormalizedApiError = {
  message: null,
  code: null,
  details: null,
  type: null,
  title: null,
  problemDetails: false,
};

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' && value ? value : null;
}

function readDetails(source: Record<string, unknown>): Readonly<Record<string, string>> | null {
  const value = source.details;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string'
  );
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

/**
 * The message a problem document carries, or `null` when it carries none.
 *
 * `detail` first: it describes this occurrence and is the same string the legacy
 * body would have put in `error`, while `title` only names the class of problem.
 *
 * The `title` fallback skips a title this build would have generated from the
 * status or the error code, and only when `type` says we generated it:
 * `about:blank` (or omitted) for a status reason phrase, this service's URI
 * for a code title. Those labels name the class of problem, not this
 * occurrence, so reporting them as a server message would invent text the
 * server never wrote and make the message depend on the `Accept` header: an
 * `ApiErrorResponse` with an empty `error` — which the schema permits, and
 * which any route forwarding a bare `Error.message` can produce — reads as no
 * message at all, while its problem rendering would otherwise read `Not found`
 * (the `NOT_FOUND` title) or `Not Found` (the 404 reason phrase). A title that
 * is neither — including a foreign type that reuses an IANA phrase — is kept.
 *
 * `error` last. Detection below is deliberately loose, so this arm also sees
 * a gateway that merged the two representations, and that body should not lose
 * its text to that looseness. `SSEErrorEvent` is recognized before the
 * problem predicate and never reaches here.
 */
function problemMessage(source: Record<string, unknown>): string | null {
  const detail = readString(source, 'detail');
  if (detail) return detail;

  const title = readString(source, 'title');
  if (title && !isGeneratedProblemTitle(title, source.type, source.status)) {
    return title;
  }

  return readString(source, 'error');
}

/**
 * Read an error body of either representation, or anything else.
 *
 * Accepts the legacy `ApiErrorResponse`, RFC 9457 problem details, a bare
 * string, and malformed or absent bodies. A body that is none of those
 * normalizes to all-`null` rather than throwing: a failed request must not fail
 * twice because the failure itself was unreadable.
 */
export function normalizeApiErrorBody(value: unknown): NormalizedApiError {
  if (typeof value === 'string') {
    return value ? { ...EMPTY, message: value } : EMPTY;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return EMPTY;

  const source = value as Record<string, unknown>;
  const legacy = value as Partial<ApiErrorResponse>;
  const problem = value as Partial<ProblemDetails>;

  // `SSEErrorEvent` is `{ type: 'error', error, done: true }`. The literal
  // `type` would otherwise satisfy the problem-document predicate below and
  // report `problemDetails: true` with problem type `error`, which is a
  // different wire shape and not an RFC 9457 type URI.
  const isSseError = source.type === 'error' && source.done === true;

  // Every standard member of a problem document is optional, and an omitted
  // `type` means `about:blank` rather than "not a problem document" — so a
  // conforming intermediary can answer `{ status: 502, detail: 'Upstream
  // failed' }` with neither `type` nor `title`. Testing only those two read that
  // body as legacy and threw its `detail` away. Any problem-specific member is
  // enough; `status` alone is not, since a number under that name says nothing
  // about which contract produced the body.
  //
  // Testing for these rather than for the absence of `error` keeps a body
  // carrying both — which nothing emits, but a proxy could synthesize —
  // readable as the richer of the two.
  const isProblem =
    !isSseError &&
    (typeof problem.type === 'string' ||
      typeof problem.title === 'string' ||
      typeof problem.detail === 'string' ||
      typeof problem.instance === 'string');

  const message = isProblem ? problemMessage(source) : readString(source, 'error');

  return {
    message,
    code: typeof legacy.code === 'string' && legacy.code ? legacy.code : null,
    details: readDetails(source),
    type: isProblem ? readString(source, 'type') : null,
    title: isProblem ? readString(source, 'title') : null,
    problemDetails: isProblem,
  };
}
