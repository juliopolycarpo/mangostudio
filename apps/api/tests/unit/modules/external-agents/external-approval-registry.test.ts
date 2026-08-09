import { describe, expect, it } from 'bun:test';
import type { ExternalApprovalRequest } from '@mangostudio/shared/external-agents';
import {
  createExternalApprovalRegistry,
  type ExternalApprovalBinding,
} from '../../../../src/modules/external-agents/application/external-approval-registry';

const BINDING: ExternalApprovalBinding = {
  userId: 'user-1',
  chatId: 'chat-1',
  sessionId: 'session-1',
  nativeTurnId: 'turn-1',
  requestId: 'req-1',
};

const REQUEST: ExternalApprovalRequest = {
  requestId: 'req-1',
  kind: 'command',
  title: 'Run the build',
  options: [
    { id: 'approve', isDestructive: false },
    { id: 'approve-for-session', isDestructive: false },
    { id: 'deny', isDestructive: true },
  ],
  expiresAtMs: 10_000,
};

function setup(startingAt = 1_000) {
  let clock = startingAt;
  const forwarded: string[] = [];
  const registry = createExternalApprovalRegistry({ now: () => clock });
  registry.register({
    binding: BINDING,
    request: REQUEST,
    forward: (optionId) => {
      forwarded.push(optionId);
      return Promise.resolve();
    },
  });
  return {
    registry,
    forwarded,
    advanceTo(next: number) {
      clock = next;
    },
  };
}

const ANSWER = { userId: 'user-1', chatId: 'chat-1', requestId: 'req-1', optionId: 'approve' };

describe('external approval registry', () => {
  it('accepts the owning user answering a live request with an offered option', async () => {
    const { registry, forwarded } = setup();

    await expect(registry.answer(ANSWER)).resolves.toEqual({
      status: 'accepted',
      optionId: 'approve',
      idempotent: false,
    });
    expect(forwarded).toEqual(['approve']);
    expect(registry.pendingCount('chat-1')).toBe(0);
  });

  it('refuses another user, without telling them the request exists', async () => {
    const { registry, forwarded } = setup();

    await expect(registry.answer({ ...ANSWER, userId: 'user-2' })).resolves.toEqual({
      status: 'rejected',
      reason: 'not-found',
    });
    expect(forwarded).toEqual([]);
  });

  it('refuses an answer aimed at another chat', async () => {
    const { registry } = setup();

    await expect(registry.answer({ ...ANSWER, chatId: 'chat-2' })).resolves.toEqual({
      status: 'rejected',
      reason: 'not-found',
    });
  });

  it('refuses an answer carrying the wrong session', async () => {
    const { registry } = setup();

    await expect(registry.answer({ ...ANSWER, sessionId: 'session-2' })).resolves.toEqual({
      status: 'rejected',
      reason: 'session-mismatch',
    });
  });

  it('refuses an answer carrying the wrong native turn', async () => {
    const { registry } = setup();

    await expect(registry.answer({ ...ANSWER, nativeTurnId: 'turn-2' })).resolves.toEqual({
      status: 'rejected',
      reason: 'turn-mismatch',
    });
  });

  it('refuses an unknown request id', async () => {
    const { registry } = setup();

    await expect(registry.answer({ ...ANSWER, requestId: 'req-2' })).resolves.toEqual({
      status: 'rejected',
      reason: 'not-found',
    });
  });

  it('refuses an option the vendor did not offer for this request', async () => {
    const { registry, forwarded } = setup();

    await expect(registry.answer({ ...ANSWER, optionId: 'approve-everything' })).resolves.toEqual({
      status: 'rejected',
      reason: 'unknown-option',
    });
    expect(forwarded).toEqual([]);
  });

  it('refuses an expired request', async () => {
    const { registry, forwarded, advanceTo } = setup();
    advanceTo(REQUEST.expiresAtMs);

    await expect(registry.answer(ANSWER)).resolves.toEqual({
      status: 'rejected',
      reason: 'expired',
    });
    expect(forwarded).toEqual([]);
  });

  it('is idempotent for a repeat with the same option', async () => {
    const { registry, forwarded } = setup();
    await registry.answer(ANSWER);

    await expect(registry.answer(ANSWER)).resolves.toEqual({
      status: 'rejected',
      reason: 'not-found',
    });
    expect(forwarded).toEqual(['approve']);
  });

  it('rejects a repeat with a different option instead of authorizing twice', async () => {
    let clock = 1_000;
    const forwarded: string[] = [];
    const registry = createExternalApprovalRegistry({ now: () => clock });
    let release: (() => void) | undefined;
    registry.register({
      binding: BINDING,
      request: REQUEST,
      forward: (optionId) =>
        new Promise((resolve) => {
          forwarded.push(optionId);
          release = () => resolve();
        }),
    });

    const first = registry.answer(ANSWER);
    // The record is written before the vendor call settles, so a second answer
    // arriving mid-flight cannot slip past it.
    await expect(registry.answer({ ...ANSWER, optionId: 'deny' })).resolves.toEqual({
      status: 'rejected',
      reason: 'already-resolved',
    });
    await expect(registry.answer(ANSWER)).resolves.toEqual({
      status: 'accepted',
      optionId: 'approve',
      idempotent: true,
    });

    clock = 2_000;
    release?.();
    await first;
    expect(forwarded).toEqual(['approve']);
  });

  it('expires everything a finished turn left outstanding', () => {
    const { registry } = setup();

    const resolutions = registry.resolvePending('chat-1', 'turn-1', 'expired', 4_000);

    expect(resolutions).toEqual([{ requestId: 'req-1', source: 'expired', resolvedAt: 4_000 }]);
    expect(registry.pendingCount('chat-1')).toBe(0);
  });

  it('leaves the other turn approvals alone when one turn ends', () => {
    const { registry } = setup();
    registry.register({
      binding: { ...BINDING, nativeTurnId: 'turn-2', requestId: 'req-2' },
      request: { ...REQUEST, requestId: 'req-2' },
      forward: () => Promise.resolve(),
    });

    registry.resolvePending('chat-1', 'turn-1', 'expired', 4_000);

    expect(registry.pendingCount('chat-1')).toBe(1);
  });

  it('drops a chat entirely when asked', () => {
    const { registry } = setup();

    registry.clearChat('chat-1');

    expect(registry.pendingCount('chat-1')).toBe(0);
  });
});
