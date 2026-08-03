import { describe, expect, it } from 'bun:test';
import { candidateState } from '../../../../src/modules/generation/application/inspect-chat-capabilities';

describe('candidateState', () => {
  it('classifies editable agent allowlist exclusions as disabled', () => {
    expect(candidateState('agent-allowlist')).toBe('disabled');
  });

  it('classifies runtime consent refusals as unavailable', () => {
    expect(candidateState('runtime-denied')).toBe('unavailable');
  });
});
