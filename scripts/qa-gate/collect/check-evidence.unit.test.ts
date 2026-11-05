import { describe, expect, test } from 'bun:test';

import {
  CHECK_INVOCATION_ID,
  completedCheckFixture,
  executedCheckTask,
} from '../../tests/support/check-result-fixture';
import { deliveredCheckCollectors } from './check-evidence';

const identity = {
  repository: 'owner/repo',
  sourceSha: 'a'.repeat(40),
  runId: 1,
  runAttempt: 2,
  invocationId: CHECK_INVOCATION_ID,
};
function makeFakeEvidenceReader(text: string | Error) {
  const paths: string[] = [];
  return {
    paths,
    read(path: string): Promise<string> {
      paths.push(path);
      return text instanceof Error ? Promise.reject(text) : Promise.resolve(text);
    },
  };
}
function completeEvidence() {
  const result = completedCheckFixture([executedCheckTask('typescript:apps:api')]);
  result.args = ['--all', '--ci-report'];
  return {
    kind: 'mangostudio.ci-check-evidence',
    schemaVersion: 1,
    identity,
    result,
    diagnostics: [{ root: 'apps/api', state: 'completed', errors: 0 }],
  };
}
describe('delivered Check collectors', () => {
  test('uses one evidence read for component and tooling metrics without invoking Check', async () => {
    const reader = makeFakeEvidenceReader(JSON.stringify(completeEvidence()));
    const collectors = deliveredCheckCollectors('check.json', identity, ['apps/api'], reader.read);
    expect(await collectors.countTsErrors('apps/api')).toBe(0);
    expect(await collectors.collectToolingStats()).toEqual({ checkExitCode: 0, failedTasks: [] });
    expect(reader.paths).toEqual(['check.json']);
  });
  test('retains diagnostic failures as measured counts and failed tooling', async () => {
    const value = completeEvidence();
    value.diagnostics[0].errors = 2;
    value.result.exitCode = 1;
    value.result.tasks = [executedCheckTask('typescript:apps:api', 1)];
    const reader = makeFakeEvidenceReader(JSON.stringify(value));
    const collectors = deliveredCheckCollectors('check.json', identity, ['apps/api'], reader.read);
    expect(await collectors.countTsErrors('apps/api')).toBe(2);
    expect(await collectors.collectToolingStats()).toEqual({
      checkExitCode: 1,
      failedTasks: ['typescript:apps:api'],
    });
  });
  test('an interrupted task keeps completed component counts but tooling unavailable', async () => {
    const value = completeEvidence();
    value.result.state = 'unavailable';
    value.result.exitCode = 1;
    value.result.tasks.push({ label: 'root:lint', state: 'unavailable', reason: 'interrupted' });
    value.result.plannedTasks.push('root:lint');
    const reader = makeFakeEvidenceReader(JSON.stringify(value));
    const collectors = deliveredCheckCollectors('check.json', identity, ['apps/api'], reader.read);
    expect(await collectors.countTsErrors('apps/api')).toBe(0);
    await expect(collectors.collectToolingStats()).rejects.toThrow('root:lint');
  });
  test('missing evidence rejects both metrics and never runs a local fallback', async () => {
    const reader = makeFakeEvidenceReader(new Error('ENOENT: check.json'));
    const collectors = deliveredCheckCollectors('check.json', identity, ['apps/api'], reader.read);
    await expect(collectors.countTsErrors('apps/api')).rejects.toThrow('ENOENT');
    await expect(collectors.collectToolingStats()).rejects.toThrow('ENOENT');
    expect(reader.paths).toEqual(['check.json']);
  });
});
