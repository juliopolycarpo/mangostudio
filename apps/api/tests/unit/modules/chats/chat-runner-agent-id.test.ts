import { describe, expect, it } from 'bun:test';
import { resolveRunnerAgentId } from '../../../../src/modules/chats/domain/chat-runner';

describe('resolveRunnerAgentId', () => {
  it('uses the persisted runner when the request names no agent', () => {
    expect(resolveRunnerAgentId({ kind: 'mangostudio', agentId: 'explore' })).toBe('explore');
  });

  it('lets an explicit request agent override the persisted runner', () => {
    expect(resolveRunnerAgentId({ kind: 'mangostudio', agentId: 'explore' }, 'user:reviewer')).toBe(
      'user:reviewer'
    );
  });

  it('falls back to default for an external runner, which has no MangoStudio agent', () => {
    expect(resolveRunnerAgentId({ kind: 'external', targetId: 'codex' })).toBe('default');
  });
});
