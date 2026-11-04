import { expect, test } from 'bun:test';

import { Value } from 'typebox/value';

import { externalAgentLoginAction } from '../../src/external-agents/login';
import login from '../../src/external-agents/login.json';
import { RuntimeTerminalOpenParamsSchema } from '../../src/runtime-contract/methods/terminal';

test('old or unavailable peers keep copy commands without terminal extension fields', () => {
  for (const target of ['codex', 'cursor', 'claude'] as const) {
    for (const manifest of [
      {},
      { terminal: true },
      { terminal: true, terminalLoginArgv: false },
      { terminalLoginArgv: true },
    ]) {
      expect(externalAgentLoginAction(target, manifest)).toEqual({
        kind: 'copy',
        command: [login[target].program, ...login[target].args].join(' '),
      });
    }
    expect(externalAgentLoginAction(target, { terminal: true, terminalLoginArgv: true })).toEqual({
      kind: 'terminal',
      loginTarget: target,
    });
  }
});

test('login target is an additive optional field with a closed product identity', () => {
  const base = { sessionId: 'one', cols: 80, rows: 24 };
  expect(Value.Check(RuntimeTerminalOpenParamsSchema, base)).toBe(true);
  expect(Value.Check(RuntimeTerminalOpenParamsSchema, { ...base, loginTarget: 'cursor' })).toBe(
    true
  );
  expect(
    Value.Check(RuntimeTerminalOpenParamsSchema, { ...base, loginTarget: 'cursor; evil' })
  ).toBe(false);
});
