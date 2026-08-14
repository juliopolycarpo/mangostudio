/**
 * Reading a failed response without knowing which representation it used.
 *
 * This is the only error-parsing path any client has, so it has to survive both
 * contracts plus everything that is neither: a proxy's HTML, a truncated body,
 * a network layer handing back a bare string. A failed request must not fail a
 * second time because the failure itself was unreadable.
 */

import { describe, expect, it } from 'bun:test';
import { normalizeApiErrorBody, toProblemDetails } from '@mangostudio/shared/errors';

describe('normalizeApiErrorBody', () => {
  it('reads the legacy shape', () => {
    expect(normalizeApiErrorBody({ error: 'Chat not found', code: 'NOT_FOUND' })).toEqual({
      message: 'Chat not found',
      code: 'NOT_FOUND',
      details: null,
      type: null,
      title: null,
      problemDetails: false,
    });
  });

  it('reads problem details', () => {
    expect(
      normalizeApiErrorBody({
        type: 'https://mangostudio.dev/problems/not-found',
        title: 'Not found',
        status: 404,
        detail: 'Chat not found',
        code: 'NOT_FOUND',
      })
    ).toEqual({
      message: 'Chat not found',
      code: 'NOT_FOUND',
      details: null,
      type: 'https://mangostudio.dev/problems/not-found',
      title: 'Not found',
      problemDetails: true,
    });
  });

  it('reports the same message and code for both representations', () => {
    // The property the whole rollout rests on: switching representation must be
    // invisible to anything that renders an error.
    const legacy = { error: 'Checkout blocked', code: 'CHECKOUT_BLOCKED' };
    const problem = toProblemDetails(legacy, 409);

    const fromLegacy = normalizeApiErrorBody(legacy);
    const fromProblem = normalizeApiErrorBody(problem);

    expect(fromProblem.message).toBe(fromLegacy.message);
    expect(fromProblem.code).toBe(fromLegacy.code);
    expect(fromProblem.details).toEqual(fromLegacy.details);
  });

  it('carries the details map across from either shape', () => {
    const details = { path: '/tmp/repo' };
    expect(normalizeApiErrorBody({ error: 'x', details }).details).toEqual(details);
    expect(normalizeApiErrorBody(toProblemDetails({ error: 'x', details }, 409)).details).toEqual(
      details
    );
  });

  it('prefers detail over title, and falls back to title', () => {
    expect(
      normalizeApiErrorBody({ type: 'about:blank', title: 'Conflict', detail: 'Already exists' })
        .message
    ).toBe('Already exists');
    expect(normalizeApiErrorBody({ type: 'about:blank', title: 'Conflict' }).message).toBe(
      'Conflict'
    );
  });

  it('recognizes a problem document from title alone', () => {
    const normalized = normalizeApiErrorBody({ title: 'Not found', status: 404 });
    expect(normalized.problemDetails).toBe(true);
    expect(normalized.message).toBe('Not found');
  });

  it('recognizes a problem document carrying neither type nor title', () => {
    // Every standard member is optional and an omitted `type` means
    // `about:blank`, so a conforming gateway can send exactly this. Reading it
    // as legacy would drop the one usable string in the body.
    const normalized = normalizeApiErrorBody({ status: 502, detail: 'Upstream failed' });
    expect(normalized.problemDetails).toBe(true);
    expect(normalized.message).toBe('Upstream failed');

    expect(normalizeApiErrorBody({ detail: 'Upstream failed' }).message).toBe('Upstream failed');
    expect(normalizeApiErrorBody({ instance: '/requests/1', status: 502 }).problemDetails).toBe(
      true
    );
  });

  it('does not treat an SSE error event as a problem document', () => {
    // `SSEErrorEvent` is a distinct supported wire shape. Its literal
    // `type: 'error'` must not trip RFC 9457 detection.
    expect(
      normalizeApiErrorBody({ type: 'error', error: 'Generation failed', done: true })
    ).toEqual({
      message: 'Generation failed',
      code: null,
      details: null,
      type: null,
      title: null,
      problemDetails: false,
    });
    expect(
      normalizeApiErrorBody({
        type: 'error',
        error: 'Generation failed',
        code: 'PROVIDER_ERROR',
        done: true,
      })
    ).toEqual({
      message: 'Generation failed',
      code: 'PROVIDER_ERROR',
      details: null,
      type: null,
      title: null,
      problemDetails: false,
    });
  });

  it('keeps the message of a body carrying both spellings', () => {
    // A proxy could merge the two HTTP representations. `detail` is absent, the
    // title is the 409 reason phrase (so it is not an occurrence message), and
    // `error` is the string that must survive.
    expect(
      normalizeApiErrorBody({
        type: 'https://mangostudio.dev/problems/conflict',
        title: 'Conflict',
        status: 409,
        error: 'Already exists',
      }).message
    ).toBe('Already exists');
  });

  it('does not report a bare status reason phrase as a server message', () => {
    // RFC 9457 §4.2.1: an `about:blank` title carries no more information than
    // the status code, so surfacing it would report words the server never
    // wrote — and would make the message depend on the `Accept` header.
    const normalized = normalizeApiErrorBody({
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
    });
    expect(normalized.problemDetails).toBe(true);
    expect(normalized.title).toBe('Not Found');
    expect(normalized.message).toBeNull();
  });

  it('keeps an about:blank title that is not the reason phrase', () => {
    expect(
      normalizeApiErrorBody({ type: 'about:blank', title: 'Quota exhausted', status: 429 }).message
    ).toBe('Quota exhausted');
  });

  it('reports the same message for both representations of an empty error', () => {
    // `ApiErrorResponseSchema` permits `error: ''`, and routes forwarding a bare
    // `Error.message` can produce it. Both representations have to agree that
    // no message was sent, or the rendered text changes with the header.
    //
    // Known codes matter as much as code-less bodies: `NOT_FOUND` titles the
    // problem `Not found`, which is not the 404 reason phrase `Not Found`, so
    // skipping only the IANA phrase would still invent a message for the
    // opted-in client.
    const bodies: { error: string; code?: string }[] = [
      { error: '' },
      { error: '', code: 'NOT_FOUND' },
      { error: '', code: 'RATE_LIMITED' },
      { error: '', code: 'INTERNAL' },
      { error: '', code: 'CONFLICT' },
    ];

    for (const legacy of bodies) {
      for (const status of [404, 409, 429, 500, 599]) {
        const fromLegacy = normalizeApiErrorBody(legacy);
        const fromProblem = normalizeApiErrorBody(toProblemDetails(legacy, status));

        expect(fromProblem.message).toBe(fromLegacy.message);
        expect(fromProblem.message).toBeNull();
      }
    }
  });

  it('reads a bare string', () => {
    expect(normalizeApiErrorBody('Network error').message).toBe('Network error');
  });

  it('returns all-null for bodies it cannot read', () => {
    const empty = {
      message: null,
      code: null,
      details: null,
      type: null,
      title: null,
      problemDetails: false,
    };

    expect(normalizeApiErrorBody(null)).toEqual(empty);
    expect(normalizeApiErrorBody(undefined)).toEqual(empty);
    expect(normalizeApiErrorBody('')).toEqual(empty);
    expect(normalizeApiErrorBody(42)).toEqual(empty);
    expect(normalizeApiErrorBody([{ error: 'x' }])).toEqual(empty);
    expect(normalizeApiErrorBody({})).toEqual(empty);
    expect(normalizeApiErrorBody({ status: 500 })).toEqual(empty);
    expect(normalizeApiErrorBody('<html><body>502 Bad Gateway</body></html>').message).toBe(
      '<html><body>502 Bad Gateway</body></html>'
    );
  });

  it('ignores members of the wrong type instead of surfacing them', () => {
    const normalized = normalizeApiErrorBody({ error: 42, code: 7, details: 'nope' });
    expect(normalized.message).toBeNull();
    expect(normalized.code).toBeNull();
    expect(normalized.details).toBeNull();
  });

  it('drops non-string entries from a details map', () => {
    expect(normalizeApiErrorBody({ error: 'x', details: { a: 'ok', b: 9 } }).details).toEqual({
      a: 'ok',
    });
    expect(normalizeApiErrorBody({ error: 'x', details: { b: 9 } }).details).toBeNull();
    expect(normalizeApiErrorBody({ error: 'x', details: [] }).details).toBeNull();
  });

  it('treats empty strings as absent', () => {
    const normalized = normalizeApiErrorBody({ error: '', code: '' });
    expect(normalized.message).toBeNull();
    expect(normalized.code).toBeNull();
  });
});
