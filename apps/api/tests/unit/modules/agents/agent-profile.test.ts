import { describe, expect, it } from 'bun:test';
import {
  AgentSettingsError,
  normalizeAgentSlug,
  profileFromBody,
  userAgentIdFromSlug,
} from '../../../../src/modules/agents/domain/agent-profile';

const PROFILE_BODY = {
  name: 'Researcher',
  description: 'Finds project context.',
  role: 'both' as const,
  systemPrompt: 'Read the repository context before answering.',
  toolNames: ['read_file', 'read_file', 'list_directory'],
  toolsEnabled: true,
  subagentIds: ['user:reviewer' as const],
  metadata: { color: 'mango' },
};

describe('agent profile domain', () => {
  it('normalizes slugs and rejects reserved or unsafe values', () => {
    expect(normalizeAgentSlug('Researcher-1')).toBe('researcher-1');
    expect(userAgentIdFromSlug('researcher')).toBe('user:researcher');

    expect(() => normalizeAgentSlug('../escape')).toThrow(AgentSettingsError);
    expect(() => normalizeAgentSlug('chat')).toThrow(AgentSettingsError);
    expect(() => normalizeAgentSlug('claude')).toThrow(AgentSettingsError);
  });

  it('normalizes profile bodies for built-in and user agents', () => {
    const builtIn = profileFromBody('default', PROFILE_BODY, { type: 'builtin' });
    const user = profileFromBody('user:researcher', PROFILE_BODY, { type: 'markdown' });

    expect(builtIn).toMatchObject({ id: 'default', kind: 'builtin', source: { type: 'builtin' } });
    expect(user).toMatchObject({ id: 'user:researcher', kind: 'user' });
    expect(user.toolNames).toEqual(['read_file', 'list_directory']);
  });
});
