import { describe, expect, test } from 'bun:test';
import {
  CHECK_RESULT_MAX_BYTES,
  type CheckResult,
  parseCheckResult,
  serializeCheckResult,
} from '../lib/check-result';
import {
  CHECK_INVOCATION_ID,
  completedCheckFixture,
  executedCheckTask,
} from './support/check-result-fixture';

const expected = { invocationId: CHECK_INVOCATION_ID, args: ['--all'], exitCode: 0 };

describe('Check result validator', () => {
  test('success keeps every labeled executed task and command exit', () => {
    const fixture = completedCheckFixture([
      executedCheckTask('workspaces:check'),
      executedCheckTask('root:biome'),
    ]);
    expect(parseCheckResult(serializeCheckResult(fixture), expected)).toEqual(fixture);
  });

  test('multiple task failures retain each failing label and nonzero task exit', () => {
    const fixture = completedCheckFixture([
      executedCheckTask('workspaces:check', 2),
      executedCheckTask('root:biome', 7),
      executedCheckTask('root:dprint'),
    ]);
    expect(parseCheckResult(JSON.stringify(fixture), { ...expected, exitCode: 1 })).toEqual(
      fixture
    );
    expect(() => parseCheckResult(JSON.stringify({ ...fixture, exitCode: 0 }), expected)).toThrow(
      'contradicts its task results'
    );
  });

  test('preserves a native Windows subprocess failure without reducing its exit status', () => {
    const fixture = completedCheckFixture([executedCheckTask('workspaces:check', 0xc0000005)]);
    const report = parseCheckResult(JSON.stringify(fixture), { ...expected, exitCode: 1 });
    expect(report.tasks).toEqual([
      { label: 'workspaces:check', state: 'executed', exitCode: 0xc0000005, durationMs: 12 },
    ]);
  });

  test('subprocess setup failure records its unavailable label with a reason', () => {
    const fixture: CheckResult = {
      ...completedCheckFixture(),
      state: 'unavailable',
      exitCode: 1,
      tasks: [{ label: 'workspaces:check', state: 'unavailable', reason: 'spawn turbo ENOENT' }],
    };
    expect(parseCheckResult(JSON.stringify(fixture), { ...expected, exitCode: 1 })).toEqual(
      fixture
    );
    expect(() =>
      parseCheckResult(JSON.stringify({ ...fixture, state: 'completed' }), expected)
    ).toThrow('unavailable tasks');
  });

  test('setup failure before task construction is explicit, never empty success', () => {
    const fixture: CheckResult = {
      ...completedCheckFixture([]),
      state: 'unavailable',
      exitCode: 1,
      error: 'Cannot resolve the comparison base',
    };
    expect(parseCheckResult(JSON.stringify(fixture), { ...expected, exitCode: 1 })).toEqual(
      fixture
    );
    expect(() => parseCheckResult(JSON.stringify(completedCheckFixture([])), expected)).toThrow(
      'no tasks'
    );
  });

  test('a scoped no-change invocation may legitimately execute no tasks', () => {
    const fixture = { ...completedCheckFixture([]), args: ['--changed'] };
    expect(parseCheckResult(JSON.stringify(fixture), { ...expected, args: ['--changed'] })).toEqual(
      fixture
    );
  });

  test('interrupted report retains finished tasks and marks unfinished labels unavailable', () => {
    const fixture: CheckResult = {
      ...completedCheckFixture([
        executedCheckTask('root:biome', 1),
        {
          label: 'workspaces:check',
          state: 'unavailable',
          reason: 'Check did not finish this task',
        },
      ]),
      state: 'unavailable',
    };
    expect(parseCheckResult(JSON.stringify(fixture), { ...expected, exitCode: 1 })).toEqual(
      fixture
    );
    expect(() => parseCheckResult(JSON.stringify(fixture), { ...expected, exitCode: 143 })).toThrow(
      'subprocess exit 143'
    );
  });

  test('truncated JSON and missing task entries cannot become a completed result', () => {
    expect(() => parseCheckResult('{"schemaVersion":1,', expected)).toThrow('not valid JSON');
    const fixture = completedCheckFixture();
    expect(() => parseCheckResult(JSON.stringify({ ...fixture, tasks: [] }), expected)).toThrow(
      'every planned task'
    );
  });

  test.each([
    ['report', { ...completedCheckFixture(), unexpected: true }],
    [
      'task',
      completedCheckFixture([{ ...executedCheckTask('root:biome'), unexpected: true } as never]),
    ],
    ['version', { ...completedCheckFixture(), schemaVersion: 2 }],
    ['producer', { ...completedCheckFixture(), kind: 'another-report' }],
    ['duration', completedCheckFixture([{ ...executedCheckTask('root:biome'), durationMs: -1 }])],
    ['missing exit', { ...completedCheckFixture(), exitCode: undefined }],
  ])('rejects unexpected or invalid %s fields', (_name, fixture) => {
    expect(() => parseCheckResult(JSON.stringify(fixture), expected)).toThrow('schema validation');
  });

  test('duplicate and reordered task identities are rejected', () => {
    const duplicate = completedCheckFixture([
      executedCheckTask('root:biome'),
      executedCheckTask('root:biome'),
    ]);
    expect(() => parseCheckResult(JSON.stringify(duplicate), expected)).toThrow('exactly once');
    const reordered = completedCheckFixture([
      executedCheckTask('root:biome'),
      executedCheckTask('workspaces:check'),
    ]);
    reordered.tasks.reverse();
    expect(() => parseCheckResult(JSON.stringify(reordered), expected)).toThrow('in order');
  });

  test('caller identity, arguments and observed process exit must match', () => {
    const text = JSON.stringify(completedCheckFixture());
    expect(() => parseCheckResult(text, { ...expected, invocationId: 'different' })).toThrow(
      'identity'
    );
    expect(() => parseCheckResult(text, { ...expected, args: ['--api'] })).toThrow('arguments');
    expect(() => parseCheckResult(text, { ...expected, exitCode: 1 })).toThrow('subprocess exit 1');
  });

  test('oversize input is rejected before parsing', () => {
    expect(() => parseCheckResult(' '.repeat(CHECK_RESULT_MAX_BYTES + 1), expected)).toThrow(
      'exceeds'
    );
  });
});
