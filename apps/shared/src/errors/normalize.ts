/**
 * One reader for both error representations.
 *
 * Clients should never branch on which representation they got. Everything that
 * consumes a failed MangoStudio response — the frontend's `ApiError`, external
 * clients, tests — goes through this function, so adding problem details did
 * not add a second parsing path anywhere.
 */

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
 * Read an error body of either representation, or anything else.
 *
 * Accepts the legacy `ApiErrorResponse`, RFC 9457 problem details, a bare
 * string, and malformed or absent bodies. A body that is none of those
 * normalizes to all-`null` rather than throwing: a failed request must not fail
 * twice because the failure itself was unreadable.
 *
 * For problem details the message is `detail` before `title` — `detail`
 * describes this occurrence and is the same string the legacy body would have
 * put in `error`, while `title` only names the class of problem.
 */
export function normalizeApiErrorBody(value: unknown): NormalizedApiError {
  if (typeof value === 'string') {
    return value ? { ...EMPTY, message: value } : EMPTY;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return EMPTY;

  const source = value as Record<string, unknown>;
  const legacy = value as Partial<ApiErrorResponse>;
  const problem = value as Partial<ProblemDetails>;

  // `type` and `title` are what a problem document has and the legacy shape
  // never does. Testing for them rather than for the absence of `error` keeps a
  // body carrying both — which nothing emits, but a proxy could synthesize —
  // readable as the richer of the two.
  const isProblem = typeof problem.type === 'string' || typeof problem.title === 'string';

  const message = isProblem
    ? (readString(source, 'detail') ?? readString(source, 'title'))
    : readString(source, 'error');

  return {
    message,
    code: typeof legacy.code === 'string' && legacy.code ? legacy.code : null,
    details: readDetails(source),
    type: isProblem ? readString(source, 'type') : null,
    title: isProblem ? readString(source, 'title') : null,
    problemDetails: isProblem,
  };
}
