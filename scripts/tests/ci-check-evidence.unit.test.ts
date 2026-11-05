import { describe, expect, test } from 'bun:test';

import {
  checkerDiagnostic,
  type CiCheckIdentity,
  parseCiCheckEvidence,
} from '../lib/ci-check-evidence';
import { completedCheckFixture, executedCheckTask } from './support/check-result-fixture';

const identity: CiCheckIdentity = {
  repository: 'owner/repo',
  sourceSha: 'a'.repeat(40),
  runId: 123,
  runAttempt: 2,
  invocationId: '12345678-1234-1234-1234-123456789abc',
};
function evidence() {
  const result = completedCheckFixture([executedCheckTask('typescript:apps:api')]);
  result.args = ['--all', '--ci-report'];
  return {
    kind: 'mangostudio.ci-check-evidence',
    schemaVersion: 1,
    identity: { ...identity },
    result,
    diagnostics: [checkerDiagnostic('apps/api', { stdout: '', stderr: '', exitCode: 0 })],
  };
}
describe('canonical CI Check evidence', () => {
  test('accepts completed source-bound report and exact component inventory', () => {
    expect(
      parseCiCheckEvidence(JSON.stringify(evidence()), identity, ['apps/api']).diagnostics
    ).toEqual([{ root: 'apps/api', state: 'completed', errors: 0 }]);
  });
  test.each(['repository', 'sourceSha', 'runId', 'runAttempt', 'invocationId'] as const)(
    'rejects wrong %s independently of report contents',
    (key) => {
      const changed = evidence();
      const expected = {
        ...identity,
        [key]:
          typeof identity[key] === 'number'
            ? 999
            : key === 'repository'
              ? 'other/repo'
              : key === 'sourceSha'
                ? 'b'.repeat(40)
                : 'abcdefab-1234-1234-1234-123456789abc',
      };
      expect(() => parseCiCheckEvidence(JSON.stringify(changed), expected, ['apps/api'])).toThrow(
        `CI Check ${key}: expected`
      );
    }
  );
  test('rejects missing and duplicate component diagnostics', () => {
    const duplicate = evidence();
    duplicate.diagnostics.push(duplicate.diagnostics[0]);
    expect(() => parseCiCheckEvidence(JSON.stringify(duplicate), identity, ['apps/api'])).toThrow(
      'exactly once'
    );
    expect(() =>
      parseCiCheckEvidence(JSON.stringify(evidence()), identity, ['apps/api', 'scripts'])
    ).toThrow('exactly once');
  });
  test('rejects diagnostics contradicting the observed task verdict', () => {
    const value = evidence();
    value.diagnostics = [{ root: 'apps/api', state: 'completed', errors: 3 }];
    expect(() => parseCiCheckEvidence(JSON.stringify(value), identity, ['apps/api'])).toThrow(
      'expected matching typescript:apps:api task state'
    );
  });
  test('does not accept a local caller report as cross-job evidence', () => {
    expect(() =>
      parseCiCheckEvidence(JSON.stringify(completedCheckFixture()), identity, ['apps/api'])
    ).toThrow('versioned identity');
  });
  test('preserves checker failures and refuses crash or contradictory output as zero', () => {
    expect(
      checkerDiagnostic('scripts', {
        stdout: 'x: error TS1234: bad',
        stderr: 'x: error TS2345: bad',
        exitCode: 1,
      })
    ).toEqual({ root: 'scripts', state: 'completed', errors: 2 });
    for (const output of [
      { stdout: '', stderr: 'OOM', exitCode: 137 },
      { stdout: 'error TS1234: bad', stderr: '', exitCode: 0 },
    ])
      expect(checkerDiagnostic('scripts', output).state).toBe('unavailable');
  });
});
