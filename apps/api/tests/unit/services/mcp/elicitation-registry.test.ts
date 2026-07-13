import { afterEach, describe, expect, it } from 'bun:test';
import {
  bindElicitationSink,
  cancelPendingElicitations,
  createPendingElicitation,
  type McpElicitationStatusEvent,
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

describe('elicitation terminal status notifications', () => {
  function bindWithObserver(toolCallId: string, statuses: McpElicitationStatusEvent[]) {
    let elicitationId = '';
    bindElicitationSink(
      'u1',
      's1',
      toolCallId,
      (part) => {
        elicitationId = part.elicitationId;
      },
      (event) => statuses.push(event)
    );
    return () => elicitationId;
  }

  function park(toolCallId: string, signal?: AbortSignal) {
    return createPendingElicitation({
      userId: 'u1',
      serverId: 's1',
      serverSlug: 'demo',
      toolCallId,
      message: 'Need input',
      fields: [],
      ...(signal ? { signal } : {}),
    });
  }

  it('notifies exactly once with reason responded and ignores late transitions', async () => {
    const statuses: McpElicitationStatusEvent[] = [];
    const getId = bindWithObserver('call-1', statuses);
    const pending = park('call-1');
    const elicitationId = getId();

    expect(respondElicitation('u1', elicitationId, { action: 'accept', content: {} })).toBe(
      'accepted'
    );
    // Late duplicate response and leftover cleanup can no longer move the state.
    expect(respondElicitation('u1', elicitationId, { action: 'decline' })).toBeNull();
    cancelPendingElicitations([elicitationId]);

    await expect(pending).resolves.toEqual({ action: 'accept', content: {} });
    expect(statuses).toEqual([
      { elicitationId, toolCallId: 'call-1', status: 'accepted', reason: 'responded' },
    ]);
  });

  it('notifies turn_aborted and marks the part cancelled when the parent aborts', async () => {
    const statuses: McpElicitationStatusEvent[] = [];
    let observedStatus = '';
    bindElicitationSink(
      'u1',
      's1',
      'call-1',
      (part, waitForResponse) => {
        void waitForResponse.then(() => {
          observedStatus = part.status;
        });
      },
      (event) => statuses.push(event)
    );
    const controller = new AbortController();
    const pending = park('call-1', controller.signal);

    controller.abort();
    await expect(pending).resolves.toEqual({ action: 'cancel' });
    expect(observedStatus).toBe('cancelled');
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toMatchObject({ status: 'cancelled', reason: 'turn_aborted' });
  });

  it('carries the given cancel reason and still notifies after sink release', async () => {
    const statuses: McpElicitationStatusEvent[] = [];
    const getId = bindWithObserver('call-1', statuses);
    const pending = park('call-1');

    releaseElicitationSink('u1', 's1', 'call-1');
    cancelPendingElicitations([getId()], 'tool_timeout');

    await expect(pending).resolves.toEqual({ action: 'cancel' });
    expect(statuses[0]).toMatchObject({ status: 'cancelled', reason: 'tool_timeout' });
  });
});
