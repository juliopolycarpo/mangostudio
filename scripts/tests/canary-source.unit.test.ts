import { describe, expect, test } from 'bun:test';

import { selectCanarySource } from '../lib/canary-source';

const repository = 'owner/repo';
function run(overrides: Record<string, unknown> = {}) {
  return {
    id: 100,
    run_attempt: 1,
    run_number: 10,
    repository: { full_name: repository },
    head_repository: { full_name: repository },
    workflow_id: 42,
    path: '.github/workflows/ci.yml',
    event: 'push',
    head_branch: 'main',
    status: 'completed',
    conclusion: 'success',
    head_sha: 'a'.repeat(40),
    html_url: 'https://github.com/owner/repo/actions/runs/100',
    ...overrides,
  };
}

describe('frozen canary source', () => {
  test('retains run, attempt, workflow, repository and exact source identity', () => {
    expect(selectCanarySource([run({ run_attempt: 3 })], repository, 42)).toEqual({
      runId: 100,
      runAttempt: 3,
      runNumber: 10,
      sourceSha: 'a'.repeat(40),
      repository,
      workflowId: 42,
      workflowPath: '.github/workflows/ci.yml',
      runUrl: 'https://github.com/owner/repo/actions/runs/100',
    });
  });
  test('an old push rerun cannot supersede a newer successful push', () => {
    expect(
      selectCanarySource(
        [
          run({ run_number: 9, run_attempt: 5, updated_at: '2099-01-01' }),
          run({ id: 101, html_url: 'https://github.com/owner/repo/actions/runs/101' }),
        ],
        repository,
        42
      ).runId
    ).toBe(101);
  });
  test('pending and failed newer pushes do not cause source drift', () => {
    expect(
      selectCanarySource(
        [
          run(),
          run({ status: 'in_progress', run_number: 11 }),
          run({ conclusion: 'failure', run_number: 12 }),
        ],
        repository,
        42
      ).runNumber
    ).toBe(10);
  });
  test('missing success fails without substituting scheduler HEAD', () => {
    expect(() => selectCanarySource([], repository, 42)).toThrow(
      'No eligible completed successful'
    );
  });
  for (const [field, value] of Object.entries({
    repository: { full_name: 'wrong/repo' },
    head_repository: { full_name: 'fork/repo' },
    path: '.github/workflows/other.yml',
    workflow_id: 43,
    event: 'pull_request',
    head_branch: 'other',
    html_url: 'https://example.com/run',
    head_sha: 'abc1234',
    run_attempt: 0,
    id: -1,
    run_number: 0,
  })) {
    test(`rejects inconsistent ${field}=${JSON.stringify(value)}`, () => {
      expect(() => selectCanarySource([run({ [field]: value })], repository, 42)).toThrow();
    });
  }
  test('rejects ambiguous ordering and invalid lookup identity', () => {
    expect(() => selectCanarySource([run(), run()], repository, 42)).toThrow(
      'Ambiguous CI run_number: 10'
    );
    expect(() => selectCanarySource([run()], 'invalid', 42)).toThrow('expected owner/repository');
    expect(() => selectCanarySource([run()], repository, 0)).toThrow(
      'expected positive safe integer'
    );
    expect(() => selectCanarySource([null], repository, 42)).toThrow(
      'Expected workflow run object'
    );
  });
});
