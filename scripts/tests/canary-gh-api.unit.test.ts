import { describe, expect, test } from 'bun:test';

import { canaryApprovalChildFailure } from '../lib/canary-approval-diagnostics';
import { createCanaryGhApi } from '../lib/canary-gh-api';
import { GitHubRetry, STANDARD_RETRY_POLICY } from '../lib/github-retry';
import { ghFailure, ghJson, ghPages, ScriptedGhRunner } from './support/scripted-gh-runner';
import { RecordedRetryEnvironment } from './support/scripted-github-http';

const WORKFLOW = 'repos/owner/repo/actions/workflows/ci.yml';
const JOBS = 'repos/owner/repo/actions/runs/7/jobs?filter=all&per_page=100';
const BAD_GATEWAY = 'gh: Bad Gateway (HTTP 502)';

function fixture() {
  const environment = new RecordedRetryEnvironment();
  const runner = new ScriptedGhRunner();
  const retry = new GitHubRetry(STANDARD_RETRY_POLICY, environment);
  return { environment, runner, retry, api: createCanaryGhApi(runner, retry) };
}

describe('createCanaryGhApi.get', () => {
  test('reads again after a 502 and returns the later answer', () => {
    const { api, runner, environment } = fixture();
    runner.script(['api', WORKFLOW], ghFailure(BAD_GATEWAY), ghJson({ id: 42 }));
    expect(api.get(WORKFLOW)).toEqual({ id: 42 });
    expect(runner.calls).toEqual([
      ['api', WORKFLOW],
      ['api', WORKFLOW],
    ]);
    expect(environment.waits).toEqual([5_000]);
  });

  test('a persistent 502 names the request, the exit code and the status after three reads', () => {
    const { api, runner, environment } = fixture();
    runner.always(['api', WORKFLOW], ghFailure(BAD_GATEWAY));
    expect(() => api.get(WORKFLOW)).toThrow(
      `GitHub API GET ${WORKFLOW}: expected successful gh exit 0 | received: exit 1 | stderr: ${BAD_GATEWAY}`
    );
    expect(runner.callsOf(['api', WORKFLOW])).toBe(3);
    expect(environment.waits).toEqual([5_000, 10_000]);
  });

  test('a 404 is not read again and fails naming the request and status', () => {
    const { api, runner, environment } = fixture();
    runner.always(['api', WORKFLOW], ghFailure('gh: Not Found (HTTP 404)'));
    expect(() => api.get(WORKFLOW)).toThrow(
      `GitHub API GET ${WORKFLOW}: expected successful gh exit 0 | received: exit 1 | stderr: gh: Not Found (HTTP 404)`
    );
    expect(runner.calls).toHaveLength(1);
    expect(environment.waits).toEqual([]);
  });

  test('redacts a signed URL and a credential from the echoed stderr', () => {
    const { api, runner } = fixture();
    runner.always(
      ['api', WORKFLOW],
      ghFailure(
        'gh: denied https://example.invalid/a.zip?sig=fixture-credential ghp_fixture1234 (HTTP 403)'
      )
    );
    let message = '';
    try {
      api.get(WORKFLOW);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('stderr: gh: denied <url> <token> (HTTP 403)');
    expect(message).not.toContain('fixture-credential');
    expect(message).not.toContain('ghp_fixture1234');
  });

  test('a body that is not JSON names the request and shows what arrived', () => {
    const { api, runner } = fixture();
    runner.always(['api', WORKFLOW], {
      exitCode: 0,
      stdout: Buffer.from('<html>proxy error</html>'),
      stderr: '',
    });
    expect(() => api.get(WORKFLOW)).toThrow(
      `Invalid GET ${WORKFLOW}; expected a JSON document | received <html>proxy error</html>`
    );
  });

  test('every read of one client spends one wait budget', () => {
    const { api, runner, environment } = fixture();
    const second = 'repos/owner/repo/actions/workflows/codeql.yml';
    runner.script(['api', WORKFLOW], ghFailure(BAD_GATEWAY), ghFailure(BAD_GATEWAY), ghJson({}));
    runner.always(['api', second], ghFailure(BAD_GATEWAY));
    api.get(WORKFLOW); // spends 5 s + 10 s
    expect(() => api.get(second)).toThrow('received: exit 1');
    // 45 s remain, so the second read still gets both of its waits, and no more.
    expect(environment.waits).toEqual([5_000, 10_000, 5_000, 10_000]);
  });
});

describe('createCanaryGhApi.list', () => {
  const ARGS = ['api', '--paginate', '--slurp', JOBS];

  test('reads the whole listing again after a 502 and flattens the pages', () => {
    const { api, runner, environment } = fixture();
    runner.script(
      ARGS,
      ghFailure(BAD_GATEWAY),
      ghPages([
        { total_count: 3, jobs: [{ id: 1 }, { id: 2 }] },
        { total_count: 3, jobs: [{ id: 3 }] },
      ])
    );
    expect(api.list(JOBS, 'jobs')).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(runner.callsOf(ARGS)).toBe(2);
    expect(environment.waits).toEqual([5_000]);
  });

  test('a persistent failure names the request and is filed as a failed read, not as incomplete metadata', () => {
    const { api, runner } = fixture();
    runner.always(ARGS, ghFailure(BAD_GATEWAY));
    let message = '';
    try {
      api.list(JOBS, 'jobs');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe(
      `GitHub API GET ${JOBS} (all pages): expected successful gh exit 0 | received: exit 1 | stderr: ${BAD_GATEWAY}`
    );
    expect(runner.callsOf(ARGS)).toBe(3);
    expect(
      canaryApprovalChildFailure('qualification', 1, Buffer.alloc(0), Buffer.from(message))
    ).toContain('GitHub read failed');
  });

  test('a 404 is not read again', () => {
    const { api, runner } = fixture();
    runner.always(ARGS, ghFailure('gh: Not Found (HTTP 404)'));
    expect(() => api.list(JOBS, 'jobs')).toThrow('stderr: gh: Not Found (HTTP 404)');
    expect(runner.calls).toHaveLength(1);
  });

  test.each([
    ['an empty page collection', [], 'expected nonempty paginated array'],
    ['a page without the collection', [{ total_count: 0 }], 'expected page.jobs array'],
    [
      'a page without a count',
      [{ jobs: [] }],
      'expected page.total_count nonnegative safe integer',
    ],
    [
      'a count that moves between pages',
      [
        { total_count: 1, jobs: [{ id: 1 }] },
        { total_count: 2, jobs: [] },
      ],
      'expected stable total_count 1 | received 2',
    ],
    [
      'fewer entries than the count',
      [{ total_count: 2, jobs: [{ id: 1 }] }],
      'expected complete jobs collection (2 entries) | received 1',
    ],
  ])('rejects %s naming the request', (_name, pages, expected) => {
    const { api, runner } = fixture();
    runner.always(ARGS, ghPages(pages));
    expect(() => api.list(JOBS, 'jobs')).toThrow(`Invalid paginated GET ${JOBS}; ${expected}`);
  });
});
