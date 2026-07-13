import { afterEach, describe, expect, it } from 'bun:test';
import {
  bindElicitationSink,
  cancelPendingElicitations,
  createPendingElicitation,
  releaseElicitationSink,
  resetElicitationRegistryForTest,
  respondElicitation,
} from '../../../../src/services/mcp/elicitation-registry';
import { flattenElicitationSchema } from '../../../../src/services/mcp/elicitation-schema';

afterEach(() => {
  resetElicitationRegistryForTest();
});

describe('flattenElicitationSchema', () => {
  it('flattens string, enum, multi-enum, number, and boolean fields', () => {
    const fields = flattenElicitationSchema({
      type: 'object',
      required: ['name', 'tier'],
      properties: {
        name: { type: 'string', title: 'Name', minLength: 1 },
        tier: {
          type: 'string',
          enum: ['free', 'pro'],
          enumNames: ['Free', 'Pro'],
          default: 'free',
        },
        tags: {
          type: 'array',
          items: { type: 'string', enum: ['a', 'b'] },
        },
        age: { type: 'integer', minimum: 0, maximum: 120 },
        notify: { type: 'boolean', default: true },
      },
    });

    expect(fields).toEqual([
      {
        name: 'name',
        title: 'Name',
        required: true,
        kind: 'string',
        minLength: 1,
      },
      {
        name: 'tier',
        required: true,
        kind: 'enum',
        options: [
          { value: 'free', label: 'Free' },
          { value: 'pro', label: 'Pro' },
        ],
        default: 'free',
      },
      {
        name: 'tags',
        required: false,
        kind: 'multi_enum',
        options: [
          { value: 'a', label: 'a' },
          { value: 'b', label: 'b' },
        ],
      },
      {
        name: 'age',
        required: false,
        kind: 'integer',
        minimum: 0,
        maximum: 120,
      },
      {
        name: 'notify',
        required: false,
        kind: 'boolean',
        default: true,
      },
    ]);
  });

  it('returns an empty list for non-object schemas', () => {
    expect(flattenElicitationSchema({ type: 'string' })).toEqual([]);
    expect(flattenElicitationSchema(null)).toEqual([]);
  });
});

describe('elicitation registry', () => {
  it('cancels when no sink is bound', async () => {
    const result = await createPendingElicitation({
      userId: 'u1',
      serverId: 's1',
      serverSlug: 'demo',
      toolCallId: 'call-1',
      message: 'Need input',
      fields: [],
    });
    expect(result).toEqual({ action: 'cancel' });
  });

  it('notifies the sink and resolves accept/decline/cancel for the owner', async () => {
    const seen: string[] = [];
    bindElicitationSink('u1', 's1', 'call-1', (part) => {
      seen.push(part.elicitationId);
    });

    const pending = createPendingElicitation({
      userId: 'u1',
      serverId: 's1',
      serverSlug: 'demo',
      toolCallId: 'call-1',
      message: 'Pick a tier',
      fields: [{ name: 'tier', required: true, kind: 'string' }],
    });

    expect(seen).toHaveLength(1);
    const elicitationId = seen[0] ?? '';

    expect(respondElicitation('other-user', elicitationId, { action: 'accept' })).toBeNull();
    expect(
      respondElicitation('u1', elicitationId, {
        action: 'accept',
        content: { tier: 'pro' },
      })
    ).toBe('accepted');

    await expect(pending).resolves.toEqual({
      action: 'accept',
      content: { tier: 'pro' },
    });
  });

  it('cancels pending elicitations when the parent signal aborts', async () => {
    const controller = new AbortController();
    bindElicitationSink('u1', 's1', 'call-1', () => undefined);

    const pending = createPendingElicitation({
      userId: 'u1',
      serverId: 's1',
      serverSlug: 'demo',
      toolCallId: 'call-1',
      message: 'Need input',
      fields: [],
      signal: controller.signal,
    });

    controller.abort();
    await expect(pending).resolves.toEqual({ action: 'cancel' });
  });

  it('cancels only the given leftovers and ignores released sinks', async () => {
    let leftoverId = '';
    bindElicitationSink('u1', 's1', 'call-1', (part) => {
      leftoverId = part.elicitationId;
    });
    const pending = createPendingElicitation({
      userId: 'u1',
      serverId: 's1',
      serverSlug: 'demo',
      toolCallId: 'call-1',
      message: 'Need input',
      fields: [],
    });

    releaseElicitationSink('u1', 's1', 'call-1');
    cancelPendingElicitations([leftoverId]);
    await expect(pending).resolves.toEqual({ action: 'cancel' });

    const afterRelease = await createPendingElicitation({
      userId: 'u1',
      serverId: 's1',
      serverSlug: 'demo',
      toolCallId: 'call-2',
      message: 'Need input',
      fields: [],
    });
    expect(afterRelease).toEqual({ action: 'cancel' });
  });

  it('routes concurrent same-server elicitations to their call-specific sinks', async () => {
    const ids: string[] = [];
    bindElicitationSink('u1', 's1', 'call-1', (part) => {
      ids[0] = part.elicitationId;
    });
    bindElicitationSink('u1', 's1', 'call-2', (part) => {
      ids[1] = part.elicitationId;
    });

    const first = createPendingElicitation({
      userId: 'u1',
      serverId: 's1',
      serverSlug: 'demo',
      toolCallId: 'call-1',
      message: 'First',
      fields: [],
    });
    const second = createPendingElicitation({
      userId: 'u1',
      serverId: 's1',
      serverSlug: 'demo',
      toolCallId: 'call-2',
      message: 'Second',
      fields: [],
    });

    releaseElicitationSink('u1', 's1', 'call-1');
    cancelPendingElicitations([ids[0] ?? '']);
    await expect(first).resolves.toEqual({ action: 'cancel' });

    expect(respondElicitation('u1', ids[1] ?? '', { action: 'decline' })).toBe('declined');
    await expect(second).resolves.toEqual({ action: 'decline' });
  });
});
