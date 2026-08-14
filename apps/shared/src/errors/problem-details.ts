/**
 * Rendering `ApiErrorResponse` as RFC 9457 problem details.
 *
 * One classification, two representations: everything here is a pure function
 * of an already-built `ApiErrorResponse` and its HTTP status, so a problem
 * document can never report a different status, a different `code`, or less
 * redaction than the legacy body it was derived from.
 */

import { ERROR_CODES, type ErrorCode } from './contracts';
import type { ApiErrorResponse, ProblemDetails } from './schemas';

/**
 * Base for every problem type URI.
 *
 * These are permanent public identifiers, not links the code follows: clients
 * are expected to compare them, and changing one is a breaking change even
 * though nothing dereferences it.
 */
export const PROBLEM_TYPE_BASE = 'https://mangostudio.dev/problems';

/**
 * Every member a plain `ApiErrorResponse` may carry.
 *
 * A body with anything beyond these is not a plain error: it is an error plus
 * domain data, and the conversion is defined only over this exact set. RFC 9457
 * would happily carry the extra as extension members — minting a private one
 * per endpoint is the thing this set exists to prevent. Both the API's runtime
 * gate and its OpenAPI generator read it, so the shape they agree to negotiate
 * cannot drift apart.
 */
export const API_ERROR_RESPONSE_MEMBERS: ReadonlySet<string> = new Set([
  'error',
  'code',
  'details',
]);

/**
 * Problem type URI for one error code.
 *
 * Derived rather than written out forty times so a URI cannot drift from the
 * code it names. `errors-problem-details.test.ts` pins the whole resulting
 * table, which is what makes a rename show up as a reviewable diff instead of a
 * silent contract break.
 */
export function problemTypeUri(code: ErrorCode): string {
  return `${PROBLEM_TYPE_BASE}/${code.toLowerCase().replaceAll('_', '-')}`;
}

/**
 * Stable, non-sensitive summary for each error code.
 *
 * Keyed by `ErrorCode` rather than by `string`, so adding a code to
 * `ERROR_CODES` without giving it a title stops the build. Titles describe the
 * *class* of problem and never the occurrence — the occurrence goes in
 * `detail`, which is the already-sanitized legacy message.
 */
const PROBLEM_TITLES: Record<ErrorCode, string> = {
  UNAUTHORIZED: 'Unauthorized',
  METHOD_NOT_ALLOWED: 'Method not allowed',
  NOT_FOUND: 'Not found',
  NOT_A_DIRECTORY: 'Not a directory',
  PERMISSION_DENIED: 'Permission denied',
  VALIDATION: 'Invalid request',
  CONFLICT: 'Conflict',
  PROVIDER_ERROR: 'Provider error',
  GENERATION_EMPTY: 'Empty generation',
  OWNERSHIP: 'Not the owner',
  RATE_LIMITED: 'Too many requests',
  UNSUPPORTED: 'Unsupported operation',
  CHATGPT_REAUTH_REQUIRED: 'ChatGPT re-authentication required',
  NOTHING_TO_COMMIT: 'Nothing to commit',
  AMEND_WITHOUT_HEAD: 'Amend without a HEAD commit',
  SIGNING_FAILED: 'Commit signing failed',
  STASH_CONFLICT: 'Stash conflict',
  CHECKOUT_BLOCKED: 'Checkout blocked',
  BRANCH_NOT_MERGED: 'Branch not merged',
  AUTH_REQUIRED: 'Authentication required',
  NON_FAST_FORWARD: 'Non-fast-forward update',
  HISTORY_DIVERGED: 'History diverged',
  GIT_LOCKED: 'Repository locked',
  GIT_COMMAND_FAILED: 'Git command failed',
  LAST_COPY_UNACKNOWLEDGED: 'Last copy not acknowledged',
  EXTERNAL_API_DISABLED: 'External API disabled',
  API_KEY_SCOPE_FORBIDDEN: 'API key scope forbidden',
  API_KEY_LIMIT_REACHED: 'API key limit reached',
  EXTERNAL_WORKSPACE_UNTRUSTED: 'Workspace not trusted',
  EXTERNAL_ISOLATION_UNPROVEN: 'Agent isolation unproven',
  EXTERNAL_DISCLOSURE_REQUIRED: 'Vendor disclosure required',
  EXTERNAL_SESSION_HELD: 'Vendor session already held',
  EXTERNAL_REVIEW_REQUIRES_GIT: 'Review requires a Git repository',
  MODEL_PROVIDER_DEPRECATED: 'Model provider no longer offered',
  INTERNAL: 'Internal server error',
};

const KNOWN_CODES = new Set<string>(Object.values(ERROR_CODES));

function isErrorCode(code: string | undefined): code is ErrorCode {
  return code !== undefined && KNOWN_CODES.has(code);
}

/**
 * Every type URI this service mints, mapped to the title it generates with it.
 *
 * Built once rather than rebuilt per lookup: {@link isGeneratedProblemTitle}
 * runs on every error a client renders, and the answer it needs is exactly
 * "does this URI come with this title", which is a key lookup.
 */
const GENERATED_TITLE_BY_TYPE: ReadonlyMap<string, string> = new Map(
  Object.values(ERROR_CODES).map((code) => [problemTypeUri(code), PROBLEM_TITLES[code]])
);

/**
 * IANA reason phrases for the statuses an error response can carry.
 *
 * A constant table keyed by number, never the `statusText` off an incoming
 * response: the point is that this title is derived from the status alone, so
 * it can never become an echo of whatever string arrived.
 */
const STATUS_REASON_PHRASES: Readonly<Record<number, string>> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  402: 'Payment Required',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  406: 'Not Acceptable',
  407: 'Proxy Authentication Required',
  408: 'Request Timeout',
  409: 'Conflict',
  410: 'Gone',
  411: 'Length Required',
  412: 'Precondition Failed',
  413: 'Content Too Large',
  414: 'URI Too Long',
  415: 'Unsupported Media Type',
  416: 'Range Not Satisfiable',
  417: 'Expectation Failed',
  421: 'Misdirected Request',
  422: 'Unprocessable Content',
  423: 'Locked',
  424: 'Failed Dependency',
  425: 'Too Early',
  426: 'Upgrade Required',
  428: 'Precondition Required',
  429: 'Too Many Requests',
  431: 'Request Header Fields Too Large',
  451: 'Unavailable For Legal Reasons',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
  505: 'HTTP Version Not Supported',
  506: 'Variant Also Negotiates',
  507: 'Insufficient Storage',
  508: 'Loop Detected',
  510: 'Not Extended',
  511: 'Network Authentication Required',
};

/**
 * Title used when a body carried no `code`, or one this build does not know.
 *
 * RFC 9457 §4.2.1 defines `about:blank` as meaning "no more information than
 * the status code", and says the title should then be that status's recommended
 * reason phrase. Advertising `type: about:blank` alongside a title of our own
 * invention would claim standard semantics while not following them, so a
 * code-less 404 has to read `Not Found`.
 *
 * Statuses outside the table fall back to their class, which is what RFC 9110
 * §15 says a client must do with a status it does not recognize anyway.
 */
function statusTitle(status: number): string {
  const phrase = STATUS_REASON_PHRASES[status];
  if (phrase) return phrase;
  if (status >= 500) return 'Server Error';
  if (status >= 400) return 'Client Error';
  return 'Error';
}

/**
 * True when `title` is one this module would have written from `status` or
 * `code` alone — a class label, not an occurrence message.
 *
 * RFC 9457 §4.2.1 already says that of the status reason phrase, and only
 * for `about:blank` (omitted `type` means the same). A foreign type that
 * happens to reuse "Conflict" is still that producer's title. The
 * code-specific titles in `PROBLEM_TITLES` are the same kind of information,
 * keyed by the error code instead of by status, and they often differ from the
 * IANA phrase only by capitalization (`Not found` vs `Not Found`). Those are
 * generated only when `type` is this service's URI for that code. A
 * negotiated body that omitted `detail` because the legacy `error` was empty
 * must not then invent a server message from that generated title, or the
 * rendered text changes with the `Accept` header.
 */
export function isGeneratedProblemTitle(title: string, type: unknown, status: unknown): boolean {
  if (
    (type === undefined || type === 'about:blank') &&
    typeof status === 'number' &&
    title === statusTitle(status)
  ) {
    return true;
  }

  if (typeof type !== 'string') return false;

  // Keyed by the URI rather than by `code`, because a merged or truncated body
  // can omit `code` while still carrying this service's type URI. That URI
  // names the class on its own; matching the title it is minted with is the
  // same generated label, not a foreign occurrence message.
  return GENERATED_TITLE_BY_TYPE.get(type) === title;
}

/**
 * The full public type/title table, in `ERROR_CODES` order.
 *
 * Exported for the contract test and for documentation generation; the API
 * itself goes through {@link toProblemDetails}.
 */
export function problemTypeTable(): { code: ErrorCode; type: string; title: string }[] {
  return Object.values(ERROR_CODES).map((code) => ({
    code,
    type: problemTypeUri(code),
    title: PROBLEM_TITLES[code],
  }));
}

/**
 * Render an `ApiErrorResponse` as problem details for a given HTTP status.
 *
 * `detail` is the legacy `error` string verbatim. That is deliberate and load
 * bearing: the legacy message is the one the error boundary already sanitized,
 * so reusing it means the negotiated representation cannot leak something the
 * default one withholds, and a client that switches representations sees the
 * same words.
 *
 * `instance` is never set. It would have to identify this occurrence, and
 * MangoStudio has no public request identifier to put there — a URL or a server
 * path would be inventing one out of internals.
 */
export function toProblemDetails(body: ApiErrorResponse, status: number): ProblemDetails {
  const code = body.code;
  const known = isErrorCode(code);

  const problem: ProblemDetails = {
    type: known ? problemTypeUri(code) : 'about:blank',
    title: known ? PROBLEM_TITLES[code] : statusTitle(status),
    status,
  };

  if (body.error) problem.detail = body.error;
  if (code !== undefined) problem.code = code;
  if (body.details !== undefined) problem.details = body.details;

  return problem;
}
