/**
 * The single `Accept` boundary for error responses.
 *
 * Every MangoStudio error — thrown or returned, from a route or from the error
 * handler's own arms — passes through here once, after classification. That is
 * the whole point of doing it in `mapResponse` rather than per route: status,
 * `code` and redaction are decided in exactly one place, and this only chooses
 * how to spell the result.
 */

import {
  API_ERROR_RESPONSE_MEMBERS,
  type ApiErrorResponse,
  ApiErrorResponseSchema,
  PROBLEM_JSON_MEDIA_TYPE,
  prefersProblemDetails,
  toProblemDetails,
} from '@mangostudio/shared/errors';
import { type Context, ElysiaStatus, StatusMap } from 'elysia';
import Value from 'typebox/value';

/**
 * Narrow a response value to a body that can be losslessly re-rendered.
 *
 * Both halves matter: the key check rejects bodies carrying more than the
 * contract, and the schema check rejects ones carrying less or the wrong types.
 *
 * The key check is not a formality. `InstallBlockedResponse` is an
 * `ApiErrorResponse` plus a `recipe` the frontend keys off to render the
 * refusal; problem details has nowhere to put `recipe`, so rewriting that body
 * would silently delete it. An endpoint whose error carries domain data keeps
 * its documented shape under either `Accept`.
 */
function asApiErrorResponse(value: unknown): ApiErrorResponse | null {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value) || value instanceof Response) return null;

  for (const key of Object.keys(value)) {
    if (!API_ERROR_RESPONSE_MEMBERS.has(key)) return null;
  }

  return Value.Check(ApiErrorResponseSchema, value) ? (value as ApiErrorResponse) : null;
}

/**
 * The status this response will actually be sent with.
 *
 * `status(409, body)` puts the code on an `ElysiaStatus` wrapper and leaves
 * `set.status` undefined, while `set.status = 409` does the opposite. Reading
 * only one of the two would emit a problem document whose `status` member
 * disagreed with its own HTTP status — the one thing RFC 9457 requires it not
 * to do.
 */
function resolveStatus(responseValue: unknown, set: Context['set']): number | null {
  const raw = responseValue instanceof ElysiaStatus ? responseValue.code : set.status;

  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string') {
    const mapped = StatusMap[raw as keyof typeof StatusMap];
    return typeof mapped === 'number' ? mapped : null;
  }
  return null;
}

/**
 * Add `Accept` to `Vary` without dropping or duplicating what is already there.
 *
 * The case-insensitive key lookup is the load-bearing part. CORS has already
 * written `Vary: Origin` by the time this runs, and adding a differently-cased
 * second key leaves both in the record — which Elysia faithfully emits as
 * `Vary: Origin, Origin, Accept`. Updating the existing key in place is what
 * keeps one well-formed header.
 */
function varyOnAccept(headers: Context['set']['headers']): void {
  const field = headers as Record<string, unknown>;
  const key = Object.keys(field).find((name) => name.toLowerCase() === 'vary');
  const existing = key ? field[key] : undefined;

  if (typeof existing !== 'string' || !existing.trim()) {
    field[key ?? 'Vary'] = 'Accept';
    return;
  }

  const present = existing.split(',').some((value) => value.trim().toLowerCase() === 'accept');
  if (!present) field[key ?? 'Vary'] = `${existing}, Accept`;
}

/**
 * Pick the representation for one response.
 *
 * Returns a problem document when the caller asked for one, and `undefined` to
 * leave the legacy response untouched — which is every request that did not opt
 * in, every non-error status, and every body this cannot re-render.
 *
 * `Vary: Accept` is set on *both* outcomes. A cache that stored the legacy body
 * without it would go on serving it to a client that asked for problem details,
 * and vice versa; the header has to describe the negotiation, not the branch
 * that happened to win.
 */
export function negotiateErrorRepresentation(
  request: Request,
  set: Context['set'],
  responseValue: unknown
): Response | undefined {
  const status = resolveStatus(responseValue, set);
  if (status === null || status < 400) return undefined;

  const payload = responseValue instanceof ElysiaStatus ? responseValue.response : responseValue;
  const body = asApiErrorResponse(payload);
  if (!body) return undefined;

  varyOnAccept(set.headers);

  if (!prefersProblemDetails(request.headers.get('accept'))) return undefined;

  // Carry `set.headers` onto the replacement rather than relying on the
  // framework to merge them into a returned `Response`. Elysia does merge them
  // today, but a 429 whose `Retry-After` vanished because the caller asked for
  // problem details would be a worse bug than not negotiating at all, and that
  // is not a behaviour worth holding a framework to across upgrades.
  //
  // Arrays (`Set-Cookie`) are left to that merge: `Headers.set` would flatten
  // them into one comma-joined value, which is a change this has no business
  // making.
  const headers = new Headers();
  for (const [key, value] of Object.entries(set.headers)) {
    if (Array.isArray(value)) continue;
    if (typeof value === 'string' || typeof value === 'number') headers.set(key, String(value));
  }
  headers.set('content-type', `${PROBLEM_JSON_MEDIA_TYPE};charset=utf-8`);

  return new Response(JSON.stringify(toProblemDetails(body, status)), { status, headers });
}
