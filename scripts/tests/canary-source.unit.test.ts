import { describe, expect, test } from 'bun:test';

import {
  canarySourceRunsQuery,
  canarySourceWindowStart,
  selectCanarySource,
} from '../lib/canary-source';

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
      'expected a completed successful main push CI run | received: none'
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
  test.each([
    { head_repository: null },
    { head_repository: { full_name: 'legacy/fork' } },
    { html_url: 'https://example.com/legacy-run' },
    { path: '.github/workflows/legacy-ci.yml' },
    { head_sha: 'legacy-short-sha' },
    { run_attempt: 0 },
    { id: -1 },
  ])('a malformed older identity %j cannot reject a valid newer winner', (legacy) => {
    const winner = run({
      id: 101,
      run_number: 11,
      html_url: 'https://github.com/owner/repo/actions/runs/101',
    });
    expect(selectCanarySource([run(legacy), winner], repository, 42).runId).toBe(101);
  });
  test('an invalid newest identity is fatal instead of falling through to an older source', () => {
    expect(() =>
      selectCanarySource(
        [run(), run({ run_number: 11, head_branch: 'unexpected' })],
        repository,
        42
      )
    ).toThrow('Inconsistent CI run');
  });
  test('every successful candidate still needs a valid run number to establish ordering', () => {
    expect(() =>
      selectCanarySource([run({ run_number: undefined }), run({ run_number: 11 })], repository, 42)
    ).toThrow('Invalid run_number: undefined; expected positive safe integer');
  });
  test('identity failures identify the mismatched fields without logging unrelated API payloads', () => {
    let failure: unknown;
    try {
      selectCanarySource(
        [run({ head_branch: 'unexpected', head_commit: { message: 'private-commit-message' } })],
        repository,
        42
      );
    } catch (caught) {
      failure = caught;
    }
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain('head_branch');
    expect(message).toContain('unexpected');
    expect(message).toContain('main');
    expect(message).not.toContain('private-commit-message');
    expect(message).not.toContain('head_commit');
  });
  test('a malformed winning repository object names its field and expected shape', () => {
    expect(() => selectCanarySource([run({ head_repository: null })], repository, 42)).toThrow(
      'head_repository object'
    );
  });
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

// Fixed named clock: no test reads the real time.
const FIXED_NOW = new Date('2026-11-13T06:17:42.918Z');
const WINDOW_START = '2026-10-14T06:17:42Z';
const FAKE_ID_BY_NUMBER = (runNumber: number) => 100 + runNumber;
function runCreated(runNumber: number, createdAt: unknown) {
  const id = FAKE_ID_BY_NUMBER(runNumber);
  return run({
    id,
    run_number: runNumber,
    created_at: createdAt,
    html_url: `https://github.com/owner/repo/actions/runs/${id}`,
  });
}

describe('canary source window', () => {
  test('window start is the clock minus the retention, at second precision', () => {
    expect(canarySourceWindowStart(FIXED_NOW)).toBe(WINDOW_START);
  });
  test('an invalid clock names the received value', () => {
    expect(() => canarySourceWindowStart(new Date('not a date'))).toThrow(
      'expected valid Date; received Invalid Date'
    );
  });
  test('query carries the created lower bound after the unchanged filters', () => {
    expect(canarySourceRunsQuery('repos/owner/repo', 42, FIXED_NOW)).toEqual({
      path: 'repos/owner/repo/actions/workflows/42/runs?branch=main&event=push&status=success&per_page=100&created=>=2026-10-14T06:17:42Z',
      since: WINDOW_START,
    });
  });
  test('selection is unchanged for runs inside the window', () => {
    const runs = [
      runCreated(9, '2026-11-01T00:00:00Z'),
      runCreated(10, WINDOW_START),
      runCreated(11, '2026-11-12T00:00:00Z'),
    ];
    expect(selectCanarySource(runs, repository, 42, { since: WINDOW_START })).toEqual(
      selectCanarySource(runs, repository, 42)
    );
    expect(selectCanarySource(runs, repository, 42, { since: WINDOW_START }).runNumber).toBe(11);
  });
  test('a winner older than the window is rejected, not replaced by an older run', () => {
    const runs = [runCreated(9, '2026-10-01T00:00:00Z'), runCreated(8, '2026-09-01T00:00:00Z')];
    expect(() => selectCanarySource(runs, repository, 42, { since: WINDOW_START })).toThrow(
      `CI run ${FAKE_ID_BY_NUMBER(9)} outside source window: expected created since ${WINDOW_START} | received: 2026-10-01T00:00:00Z`
    );
  });
  test('the empty window error names the window it searched', () => {
    expect(() => selectCanarySource([], repository, 42, { since: WINDOW_START })).toThrow(
      `expected a completed successful main push CI run created since ${WINDOW_START} | received: none`
    );
  });
  test.each([undefined, 'yesterday', 20261113])(
    'a winner with created_at %j names the expected timestamp',
    (createdAt) => {
      expect(() =>
        selectCanarySource([runCreated(9, createdAt)], repository, 42, { since: WINDOW_START })
      ).toThrow(
        `Invalid created_at of CI run ${FAKE_ID_BY_NUMBER(9)}: expected ISO timestamp; received ${JSON.stringify(createdAt)}`
      );
    }
  );
});
