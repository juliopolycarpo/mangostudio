/**
 * The public problem-details contract.
 *
 * Two things are pinned here. The first is the type/title table: a problem
 * `type` is a permanent public identifier that clients are expected to compare,
 * so renaming an error code has to show up as a reviewed diff rather than as a
 * silent break in somebody's error handling. The second is that rendering a
 * problem document cannot add, drop, or reword anything the legacy body said —
 * the two representations are one classification spelled two ways.
 */

import { describe, expect, it } from 'bun:test';
import {
  API_ERROR_RESPONSE_MEMBERS,
  type ApiErrorResponse,
  ApiErrorResponseSchema,
  ERROR_CODES,
  type ErrorCode,
  PROBLEM_TYPE_BASE,
  ProblemDetailsSchema,
  problemTypeTable,
  problemTypeUri,
  toProblemDetails,
} from '@mangostudio/shared/errors';
import Value from 'typebox/value';

/**
 * The published table, written out.
 *
 * Regenerate deliberately, never mechanically: every line is a URI a client may
 * already be matching on.
 */
const PUBLISHED: [ErrorCode, string, string][] = [
  ['UNAUTHORIZED', 'https://mangostudio.dev/problems/unauthorized', 'Unauthorized'],
  [
    'METHOD_NOT_ALLOWED',
    'https://mangostudio.dev/problems/method-not-allowed',
    'Method not allowed',
  ],
  ['NOT_FOUND', 'https://mangostudio.dev/problems/not-found', 'Not found'],
  ['NOT_A_DIRECTORY', 'https://mangostudio.dev/problems/not-a-directory', 'Not a directory'],
  ['PERMISSION_DENIED', 'https://mangostudio.dev/problems/permission-denied', 'Permission denied'],
  ['VALIDATION', 'https://mangostudio.dev/problems/validation', 'Invalid request'],
  ['CONFLICT', 'https://mangostudio.dev/problems/conflict', 'Conflict'],
  ['PROVIDER_ERROR', 'https://mangostudio.dev/problems/provider-error', 'Provider error'],
  ['GENERATION_EMPTY', 'https://mangostudio.dev/problems/generation-empty', 'Empty generation'],
  ['OWNERSHIP', 'https://mangostudio.dev/problems/ownership', 'Not the owner'],
  ['RATE_LIMITED', 'https://mangostudio.dev/problems/rate-limited', 'Too many requests'],
  ['UNSUPPORTED', 'https://mangostudio.dev/problems/unsupported', 'Unsupported operation'],
  [
    'CHATGPT_REAUTH_REQUIRED',
    'https://mangostudio.dev/problems/chatgpt-reauth-required',
    'ChatGPT re-authentication required',
  ],
  ['NOTHING_TO_COMMIT', 'https://mangostudio.dev/problems/nothing-to-commit', 'Nothing to commit'],
  [
    'AMEND_WITHOUT_HEAD',
    'https://mangostudio.dev/problems/amend-without-head',
    'Amend without a HEAD commit',
  ],
  ['SIGNING_FAILED', 'https://mangostudio.dev/problems/signing-failed', 'Commit signing failed'],
  ['STASH_CONFLICT', 'https://mangostudio.dev/problems/stash-conflict', 'Stash conflict'],
  ['CHECKOUT_BLOCKED', 'https://mangostudio.dev/problems/checkout-blocked', 'Checkout blocked'],
  ['BRANCH_NOT_MERGED', 'https://mangostudio.dev/problems/branch-not-merged', 'Branch not merged'],
  ['AUTH_REQUIRED', 'https://mangostudio.dev/problems/auth-required', 'Authentication required'],
  [
    'NON_FAST_FORWARD',
    'https://mangostudio.dev/problems/non-fast-forward',
    'Non-fast-forward update',
  ],
  ['HISTORY_DIVERGED', 'https://mangostudio.dev/problems/history-diverged', 'History diverged'],
  ['GIT_LOCKED', 'https://mangostudio.dev/problems/git-locked', 'Repository locked'],
  [
    'GIT_COMMAND_FAILED',
    'https://mangostudio.dev/problems/git-command-failed',
    'Git command failed',
  ],
  [
    'LAST_COPY_UNACKNOWLEDGED',
    'https://mangostudio.dev/problems/last-copy-unacknowledged',
    'Last copy not acknowledged',
  ],
  [
    'EXTERNAL_API_DISABLED',
    'https://mangostudio.dev/problems/external-api-disabled',
    'External API disabled',
  ],
  [
    'API_KEY_SCOPE_FORBIDDEN',
    'https://mangostudio.dev/problems/api-key-scope-forbidden',
    'API key scope forbidden',
  ],
  [
    'API_KEY_LIMIT_REACHED',
    'https://mangostudio.dev/problems/api-key-limit-reached',
    'API key limit reached',
  ],
  [
    'EXTERNAL_WORKSPACE_UNTRUSTED',
    'https://mangostudio.dev/problems/external-workspace-untrusted',
    'Workspace not trusted',
  ],
  [
    'EXTERNAL_ISOLATION_UNPROVEN',
    'https://mangostudio.dev/problems/external-isolation-unproven',
    'Agent isolation unproven',
  ],
  [
    'EXTERNAL_DISCLOSURE_REQUIRED',
    'https://mangostudio.dev/problems/external-disclosure-required',
    'Vendor disclosure required',
  ],
  [
    'EXTERNAL_SESSION_HELD',
    'https://mangostudio.dev/problems/external-session-held',
    'Vendor session already held',
  ],
  [
    'EXTERNAL_REVIEW_REQUIRES_GIT',
    'https://mangostudio.dev/problems/external-review-requires-git',
    'Review requires a Git repository',
  ],
  [
    'MODEL_PROVIDER_DEPRECATED',
    'https://mangostudio.dev/problems/model-provider-deprecated',
    'Model provider no longer offered',
  ],
  ['TERMINAL_DISABLED', 'https://mangostudio.dev/problems/terminal-disabled', 'Terminals disabled'],
  ['TERMINAL_LIMIT', 'https://mangostudio.dev/problems/terminal-limit', 'Terminal limit reached'],
  [
    'TERMINAL_NOT_ISOLATED',
    'https://mangostudio.dev/problems/terminal-not-isolated',
    'Terminal host not isolated',
  ],
  ['INTERNAL', 'https://mangostudio.dev/problems/internal', 'Internal server error'],
];

describe('problem type table', () => {
  it('publishes exactly the recorded types and titles', () => {
    expect(problemTypeTable().map((row) => [row.code, row.type, row.title])).toEqual(PUBLISHED);
  });

  it('covers every error code exactly once', () => {
    const codes = problemTypeTable().map((row) => row.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(new Set(codes)).toEqual(new Set(Object.values(ERROR_CODES)));
  });

  it('gives every code a distinct type URI under one stable base', () => {
    const types = problemTypeTable().map((row) => row.type);
    expect(new Set(types).size).toBe(types.length);
    for (const type of types) expect(type.startsWith(`${PROBLEM_TYPE_BASE}/`)).toBe(true);
  });

  it('never puts an internal detail in a title', () => {
    for (const { title } of problemTypeTable()) {
      expect(title.length).toBeGreaterThan(0);
      expect(title).not.toContain('/');
      expect(title).not.toContain('\n');
    }
  });

  it('derives type URIs as lowercase kebab-case', () => {
    expect(problemTypeUri(ERROR_CODES.NOT_FOUND)).toBe(`${PROBLEM_TYPE_BASE}/not-found`);
    expect(problemTypeUri(ERROR_CODES.LAST_COPY_UNACKNOWLEDGED)).toBe(
      `${PROBLEM_TYPE_BASE}/last-copy-unacknowledged`
    );
  });
});

describe('ProblemDetailsSchema', () => {
  it('accepts a minimal document', () => {
    expect(
      Value.Check(ProblemDetailsSchema, { type: 'about:blank', title: 'Not found', status: 404 })
    ).toBe(true);
  });

  it('requires type, title and status', () => {
    expect(Value.Check(ProblemDetailsSchema, { title: 'x', status: 404 })).toBe(false);
    expect(Value.Check(ProblemDetailsSchema, { type: 'about:blank', status: 404 })).toBe(false);
    expect(Value.Check(ProblemDetailsSchema, { type: 'about:blank', title: 'x' })).toBe(false);
  });

  it('requires status to be an integer', () => {
    expect(
      Value.Check(ProblemDetailsSchema, { type: 'about:blank', title: 'x', status: 404.5 })
    ).toBe(false);
    expect(
      Value.Check(ProblemDetailsSchema, { type: 'about:blank', title: 'x', status: '404' })
    ).toBe(false);
  });

  it('rejects unknown members', () => {
    // `additionalProperties: false` is what stops an endpoint from smuggling
    // domain data into a problem document instead of keeping its own shape.
    expect(
      Value.Check(ProblemDetailsSchema, {
        type: 'about:blank',
        title: 'x',
        status: 404,
        recipe: { id: 'node-22' },
      })
    ).toBe(false);
  });

  it('names exactly the members ApiErrorResponse declares', () => {
    // `API_ERROR_RESPONSE_MEMBERS` is what the API's runtime gate and its
    // OpenAPI generator both use to decide whether a body is a plain error and
    // can therefore be re-rendered. Drifting from the schema in either
    // direction is a silent bug: too narrow and negotiation stops happening,
    // too wide and a body with domain data gets rewritten and loses it.
    expect(API_ERROR_RESPONSE_MEMBERS).toEqual(
      new Set(Object.keys(ApiErrorResponseSchema.properties))
    );
  });

  it('is disjoint from the legacy shape', () => {
    // A client can tell the two apart without looking at Content-Type.
    const problem = toProblemDetails({ error: 'Not found', code: 'NOT_FOUND' }, 404);
    expect(Value.Check(ApiErrorResponseSchema, problem)).toBe(false);
    expect(Value.Check(ProblemDetailsSchema, { error: 'Not found', code: 'NOT_FOUND' })).toBe(
      false
    );
  });
});

describe('toProblemDetails', () => {
  it('renders a known code with its published type and title', () => {
    expect(toProblemDetails({ error: 'Too many requests', code: 'RATE_LIMITED' }, 429)).toEqual({
      type: 'https://mangostudio.dev/problems/rate-limited',
      title: 'Too many requests',
      status: 429,
      detail: 'Too many requests',
      code: 'RATE_LIMITED',
    });
  });

  it('reuses the legacy message verbatim as detail', () => {
    // Load bearing. The legacy message is the string the error boundary already
    // sanitized, so a negotiated body cannot leak what the default one withheld.
    const body: ApiErrorResponse = { error: 'An internal error occurred', code: 'INTERNAL' };
    expect(toProblemDetails(body, 500).detail).toBe(body.error);
  });

  it('carries status, code and details across unchanged', () => {
    const body: ApiErrorResponse = {
      error: 'Checkout blocked',
      code: 'CHECKOUT_BLOCKED',
      details: { path: '/tmp/repo' },
    };
    const problem = toProblemDetails(body, 409);

    expect(problem.status).toBe(409);
    expect(problem.code).toBe(body.code);
    expect(problem.details).toEqual(body.details);
  });

  it('falls back to about:blank for a body with no code', () => {
    expect(toProblemDetails({ error: 'Something failed' }, 400)).toEqual({
      type: 'about:blank',
      title: 'Bad Request',
      status: 400,
      detail: 'Something failed',
    });
  });

  it('falls back to about:blank for a code this build does not know', () => {
    // Forward compatibility: an older binary must not crash or invent a URI for
    // a code a newer one introduced.
    const problem = toProblemDetails({ error: 'New failure', code: 'SOMETHING_NEW' }, 503);

    expect(problem.type).toBe('about:blank');
    expect(problem.code).toBe('SOMETHING_NEW');
    expect(problem.title).toBe('Service Unavailable');
  });

  it('titles about:blank with the status reason phrase', () => {
    // RFC 9457 §4.2.1 gives `about:blank` a fixed meaning — "no more
    // information than the status code" — and pins its title to that status's
    // reason phrase. Advertising the standard type under a title of our own
    // invention would claim semantics we then did not follow.
    const phrases: [number, string][] = [
      [401, 'Unauthorized'],
      [403, 'Forbidden'],
      [404, 'Not Found'],
      [409, 'Conflict'],
      [422, 'Unprocessable Content'],
      [429, 'Too Many Requests'],
      [500, 'Internal Server Error'],
      [502, 'Bad Gateway'],
      [504, 'Gateway Timeout'],
    ];

    for (const [status, title] of phrases) {
      expect(toProblemDetails({ error: 'x' }, status).title).toBe(title);
    }
  });

  it('falls back to the status class for an unregistered status', () => {
    expect(toProblemDetails({ error: 'x' }, 499).title).toBe('Client Error');
    expect(toProblemDetails({ error: 'x' }, 599).title).toBe('Server Error');
  });

  it('omits detail rather than emitting an empty one', () => {
    expect(toProblemDetails({ error: '' }, 500).detail).toBeUndefined();
  });

  it('never sets instance', () => {
    // There is no public request identifier to put there, and a URL or a server
    // path would be inventing one out of internals.
    expect(toProblemDetails({ error: 'x', code: 'INTERNAL' }, 500).instance).toBeUndefined();
  });

  it('produces a schema-valid document for every error code', () => {
    for (const code of Object.values(ERROR_CODES)) {
      const problem = toProblemDetails({ error: 'message', code }, 400);
      expect(Value.Check(ProblemDetailsSchema, problem)).toBe(true);
      expect(problem.status).toBe(400);
      expect(problem.code).toBe(code);
    }
  });
});
