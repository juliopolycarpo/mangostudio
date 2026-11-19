import { describe, expect, it } from 'bun:test';

import { runtimeSessionStateOf } from '../../../../src/modules/external-agents/domain/external-runtime-session-state';

const REPORT = {
  liveSessions: [
    { sessionId: 'session-idle', state: 'idle' },
    { sessionId: 'session-running', state: 'running' },
    { sessionId: 'session-closing', state: 'closing' },
    { sessionId: 'session-future', state: 'draining' },
  ],
};

describe('runtimeSessionStateOf', () => {
  it.each([
    ['session-idle', 'idle'],
    ['session-running', 'running'],
    ['session-closing', 'closing'],
  ] as const)('reads the runtime state of %s as %s', (sessionId, expected) => {
    expect(runtimeSessionStateOf(REPORT, sessionId)).toBe(expected);
  });

  it('reads a state string it has no meaning for as unknown, never as idle', () => {
    expect(runtimeSessionStateOf(REPORT, 'session-future')).toBe('unknown');
  });

  it('reads a session absent from the rows as unlisted, since the report caps its rows', () => {
    expect(runtimeSessionStateOf(REPORT, 'session-missing')).toBe('unlisted');
  });

  it('reads a report from a runtime with no externalAgents subtree as unlisted', () => {
    expect(runtimeSessionStateOf(undefined, 'session-idle')).toBe('unlisted');
  });
});
