/**
 * The generated document has to describe what the server actually does.
 *
 * The amendment is driven off the same member set the runtime negotiator reads,
 * so the two agree by construction — but "by construction" is only true while
 * the two gates stay in step, and the point of these cases is to catch the day
 * one of them stops. An over-documented status tells a generated client to
 * expect a body it will never receive; an under-documented one hides the
 * feature from every consumer of the spec.
 */

import { describe, expect, it } from 'bun:test';
import { PROBLEM_JSON_MEDIA_TYPE } from '@mangostudio/shared/errors';
import { withProblemDetailsMedia } from '../../../src/server/openapi-problem-details';

const PROBLEM_REF = { $ref: '#/components/schemas/ProblemDetails' };

const apiErrorSchema = {
  type: 'object',
  required: ['error'],
  properties: {
    error: { type: 'string' },
    code: { type: 'string' },
    details: { type: 'object', patternProperties: { '^.*$': { type: 'string' } } },
  },
};

const installBlockedSchema = {
  type: 'object',
  required: ['error', 'recipe'],
  properties: {
    error: { type: 'string' },
    code: { type: 'string' },
    recipe: { type: 'object' },
  },
};

function documentWith(responses: Record<string, unknown>) {
  return {
    openapi: '3.1.0',
    info: { title: 'MangoStudio API', version: '1.0.0' },
    paths: { '/api/thing': { get: { responses } } },
  };
}

function jsonResponse(schema: unknown) {
  return { description: 'x', content: { 'application/json': { schema } } };
}

function mediaTypes(document: ReturnType<typeof documentWith>, status: string) {
  const responses = document.paths['/api/thing']?.get?.responses as Record<
    string,
    { content?: Record<string, unknown> }
  >;
  return Object.keys(responses[status]?.content ?? {});
}

describe('withProblemDetailsMedia', () => {
  it('adds the problem media type beside a plain error body', () => {
    const amended = withProblemDetailsMedia(documentWith({ 404: jsonResponse(apiErrorSchema) }));

    expect(mediaTypes(amended, '404')).toEqual(['application/json', PROBLEM_JSON_MEDIA_TYPE]);
    expect(
      (amended.paths['/api/thing'].get.responses['404'] as { content: Record<string, unknown> })
        .content[PROBLEM_JSON_MEDIA_TYPE]
    ).toEqual({ schema: PROBLEM_REF });
  });

  it('publishes the ProblemDetails schema it references', () => {
    const amended = withProblemDetailsMedia(
      documentWith({ 404: jsonResponse(apiErrorSchema) })
    ) as unknown as { components: { schemas: Record<string, { required?: string[] }> } };

    const schema = amended.components.schemas.ProblemDetails;
    expect(schema).toBeDefined();
    expect(schema?.required).toEqual(['type', 'title', 'status']);
  });

  it('leaves successful responses alone', () => {
    const amended = withProblemDetailsMedia(
      documentWith({
        200: jsonResponse({ type: 'object', properties: { ok: { type: 'boolean' } } }),
        404: jsonResponse(apiErrorSchema),
      })
    );

    expect(mediaTypes(amended, '200')).toEqual(['application/json']);
    expect(mediaTypes(amended, '404')).toEqual(['application/json', PROBLEM_JSON_MEDIA_TYPE]);
  });

  it('leaves an error carrying domain data alone', () => {
    // Mirrors the runtime gate: the server will not re-render this body, so the
    // document must not claim it can.
    const amended = withProblemDetailsMedia(
      documentWith({ 403: jsonResponse(installBlockedSchema) })
    );

    expect(mediaTypes(amended, '403')).toEqual(['application/json']);
  });

  it('negotiates a union when one branch is a plain error', () => {
    const amended = withProblemDetailsMedia(
      documentWith({
        409: jsonResponse({ anyOf: [installBlockedSchema, apiErrorSchema] }),
      })
    );

    expect(mediaTypes(amended, '409')).toContain(PROBLEM_JSON_MEDIA_TYPE);
  });

  it('leaves a union alone when no branch is a plain error', () => {
    const amended = withProblemDetailsMedia(
      documentWith({
        409: jsonResponse({ anyOf: [installBlockedSchema, { type: 'object', properties: {} }] }),
      })
    );

    expect(mediaTypes(amended, '409')).toEqual(['application/json']);
  });

  it('ignores a 4xx body that is not an error shape at all', () => {
    const amended = withProblemDetailsMedia(
      documentWith({
        400: jsonResponse({ type: 'object', properties: { detail: { type: 'string' } } }),
        401: jsonResponse({ type: 'string' }),
        402: { description: 'no content at all' },
      })
    );

    expect(mediaTypes(amended, '400')).toEqual(['application/json']);
    expect(mediaTypes(amended, '401')).toEqual(['application/json']);
    expect(mediaTypes(amended, '402')).toEqual([]);
  });

  it('documents the negotiation itself', () => {
    const amended = withProblemDetailsMedia(
      documentWith({ 404: jsonResponse(apiErrorSchema) })
    ) as unknown as { info: { description?: string } };

    expect(amended.info.description).toContain(PROBLEM_JSON_MEDIA_TYPE);
    expect(amended.info.description).toContain('Vary: Accept');
  });

  it('does not mutate the document it was handed', () => {
    // It runs on a response hook, over an object the plugin may be caching.
    const original = documentWith({ 404: jsonResponse(apiErrorSchema) });
    const snapshot = structuredClone(original);

    withProblemDetailsMedia(original);

    expect(original).toEqual(snapshot);
  });

  it('is idempotent', () => {
    const once = withProblemDetailsMedia(documentWith({ 404: jsonResponse(apiErrorSchema) }));
    const twice = withProblemDetailsMedia(once);

    expect(twice).toEqual(once);
  });

  it('survives a document with nothing to amend', () => {
    expect(() => withProblemDetailsMedia({})).not.toThrow();
    expect(withProblemDetailsMedia(null)).toBeNull();
    expect(withProblemDetailsMedia(undefined)).toBeUndefined();
    expect(() => withProblemDetailsMedia({ paths: { '/x': { parameters: [] } } })).not.toThrow();
  });
});
