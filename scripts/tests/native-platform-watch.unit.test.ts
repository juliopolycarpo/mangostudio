import { describe, expect, test } from 'bun:test';

import { parseWatchArguments } from '../ci/native-platform-watch';
import { GithubNativeWatchApi, NATIVE_WATCH_REQUEST_TIMEOUT_MS } from '../ci/native-watch/api';
import {
  parseNativeVerdict,
  reportNativeResult,
  shouldSkipScheduledRun,
  trackingMarker,
} from '../ci/native-watch/decide';
import { GitHubRetry, STANDARD_RETRY_POLICY } from '../lib/github-retry';
import { FakeNativeWatchApi } from './support/fake-native-watch-api';
import { readText } from './support/read-text';
import {
  RecordedRetryEnvironment,
  ScriptedGitHubHttp,
  type ScriptedReply,
} from './support/scripted-github-http';
import { workflowFiles } from './support/workflow-files';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const MAIN = 'refs/heads/main';
const BRANCH = 'refs/heads/ci/probe';
const RUN_URL = 'https://github.com/owner/repo/actions/runs/7';

function report(
  api: FakeNativeWatchApi,
  overrides: Partial<Parameters<typeof reportNativeResult>[0]> = {}
) {
  const lines: string[] = [];
  const done = reportNativeResult({
    api,
    ref: MAIN,
    sha: SHA_B,
    runId: 7,
    runUrl: RUN_URL,
    verdict: 'failure',
    event: 'schedule',
    dryRun: false,
    log: (line) => lines.push(line),
    ...overrides,
  });
  return done.then(() => lines);
}

function failingApi(): FakeNativeWatchApi {
  const api = new FakeNativeWatchApi();
  api.jobs = [
    { name: 'Native candidate (windows-latest)', conclusion: 'failure' },
    { name: 'Native candidate (macos-latest)', conclusion: 'success' },
    { name: 'Native candidate (ubuntu-latest)', conclusion: 'failure' },
    { name: 'Report scheduled native result', conclusion: null },
  ];
  return api;
}

describe('shouldSkipScheduledRun', () => {
  test('skips when main still sits at the last successfully qualified commit', async () => {
    const api = new FakeNativeWatchApi();
    api.lastScheduledSha = SHA_A;
    const decision = await shouldSkipScheduledRun({ api, event: 'schedule', sha: SHA_A });
    expect(decision.skip).toBe(true);
  });

  test('runs when main moved since the last successful scheduled run', async () => {
    const api = new FakeNativeWatchApi();
    api.lastScheduledSha = SHA_A;
    expect((await shouldSkipScheduledRun({ api, event: 'schedule', sha: SHA_B })).skip).toBe(false);
  });

  test('runs when no scheduled run has succeeded yet', async () => {
    const api = new FakeNativeWatchApi();
    expect((await shouldSkipScheduledRun({ api, event: 'schedule', sha: SHA_A })).skip).toBe(false);
  });

  test('never skips a manual dispatch, even at the qualified commit', async () => {
    const api = new FakeNativeWatchApi();
    api.lastScheduledSha = SHA_A;
    expect(
      (await shouldSkipScheduledRun({ api, event: 'workflow_dispatch', sha: SHA_A })).skip
    ).toBe(false);
  });
});

describe('reportNativeResult', () => {
  test('opens one labelled issue naming the failing jobs and the run URL', async () => {
    const api = failingApi();
    await report(api);
    expect(api.calls).toEqual([
      'create #100 ci: native platform tests failing on main [type: ci, status: needs triage]',
    ]);
    const body = api.issues[0].body;
    expect(body).toContain(trackingMarker(MAIN));
    expect(body).toContain('- Native candidate (windows-latest): failure');
    expect(body).toContain('- Native candidate (ubuntu-latest): failure');
    expect(body).not.toContain('macos-latest');
    expect(body).not.toContain('Report scheduled native result');
    expect(body).toContain(RUN_URL);
  });

  test('a second failing run comments on the open issue instead of opening another', async () => {
    const api = failingApi();
    await report(api);
    await report(api, { runId: 8, runUrl: 'https://github.com/owner/repo/actions/runs/8' });
    expect(api.calls.filter((call) => call.startsWith('create'))).toHaveLength(1);
    expect(api.calls).toContain('comment #100');
    expect(api.comments.get(100)?.[0]).toContain('actions/runs/8');
  });

  test('reporting the same run twice does not repeat its comment', async () => {
    const api = failingApi();
    await report(api);
    await report(api, { runId: 8, runUrl: 'https://github.com/owner/repo/actions/runs/8' });
    await report(api, { runId: 8, runUrl: 'https://github.com/owner/repo/actions/runs/8' });
    expect(api.calls.filter((call) => call.startsWith('comment'))).toHaveLength(1);
  });

  test('re-running the run that opened the issue does not comment: its URL is in the issue body', async () => {
    const api = failingApi();
    await report(api);
    const lines = await report(api);
    expect(api.calls).toHaveLength(1);
    expect(lines).toEqual([`issue #100 already names ${RUN_URL}`]);
  });

  test('a run whose URL only prefixes a reported one is still reported', async () => {
    const api = failingApi();
    await report(api, { runId: 5, runUrl: 'https://github.com/owner/repo/actions/runs/5' });
    await report(api, { runId: 70, runUrl: 'https://github.com/owner/repo/actions/runs/70' });
    await report(api);
    expect(api.calls.filter((call) => call.startsWith('comment'))).toHaveLength(2);
    expect(api.comments.get(100)?.[1]).toContain(`Run: ${RUN_URL}`);
  });

  test('a green run comments on and closes the open issue', async () => {
    const api = failingApi();
    await report(api);
    await report(api, { verdict: 'success' });
    expect(api.calls.slice(1)).toEqual(['comment #100', 'close #100']);
    expect(api.issues).toEqual([]);
  });

  test('a green run with no open issue does nothing', async () => {
    const api = new FakeNativeWatchApi();
    await report(api, { verdict: 'success' });
    expect(api.calls).toEqual([]);
  });

  test('a skipped run leaves the issue alone', async () => {
    const api = failingApi();
    await report(api);
    await report(api, { verdict: 'skipped' });
    expect(api.calls).toHaveLength(1);
  });

  // Verified on a real run: a job that reaches timeout-minutes concludes as
  // cancelled, and so does the run, while a downstream job still runs.
  test('a timed-out job (reported as cancelled) opens an issue that lists it', async () => {
    const api = new FakeNativeWatchApi();
    api.jobs = [
      { name: 'Native candidate (windows-latest)', conclusion: 'cancelled' },
      { name: 'Native candidate (macos-latest)', conclusion: 'success' },
      { name: 'Report scheduled native result', conclusion: null },
    ];
    await report(api, { verdict: 'cancelled' });
    expect(api.calls).toEqual([expect.stringContaining('create #100')]);
    expect(api.issues[0].body).toContain('- Native candidate (windows-latest): cancelled');
    expect(api.issues[0].body).not.toContain('macos-latest');
  });

  test('a manual dispatch reports nothing, failed or green', async () => {
    const api = failingApi();
    await report(api, { event: 'workflow_dispatch', ref: BRANCH });
    await report(api, { event: 'workflow_dispatch', verdict: 'success' });
    expect(api.calls).toEqual([]);
  });

  test('a rehearsal reports from a manual dispatch on a branch', async () => {
    const api = new FakeNativeWatchApi();
    await report(api, { event: 'workflow_dispatch', ref: BRANCH, rehearsal: 'failure' });
    expect(api.calls).toEqual([expect.stringContaining('failing on ci/probe')]);
  });

  test('a rehearsal on main without a dry run is refused before it touches any issue', async () => {
    const api = new FakeNativeWatchApi();
    api.issues = [{ number: 5, body: trackingMarker(MAIN), author: 'github-actions[bot]' }];
    await expect(report(api, { event: 'workflow_dispatch', rehearsal: 'success' })).rejects.toThrow(
      'Invalid rehearsal success on refs/heads/main without a dry run'
    );
    expect(api.calls).toEqual([]);
  });

  test('a rehearsal on main with a dry run only logs', async () => {
    const api = new FakeNativeWatchApi();
    api.issues = [{ number: 5, body: trackingMarker(MAIN), author: 'github-actions[bot]' }];
    const lines = await report(api, {
      event: 'workflow_dispatch',
      rehearsal: 'success',
      dryRun: true,
    });
    expect(api.calls).toEqual([]);
    expect(lines.join('\n')).toContain('dry run: would comment on and close issue #5');
  });

  test('ignores issues from other authors, other refs and unmarked bodies', async () => {
    const api = failingApi();
    api.issues = [
      { number: 1, body: trackingMarker(MAIN), author: 'someone' },
      { number: 2, body: trackingMarker('refs/heads/other'), author: 'github-actions[bot]' },
      { number: 3, body: 'no marker', author: 'github-actions[bot]' },
    ];
    await report(api);
    expect(api.calls).toEqual([expect.stringContaining('create #100')]);
  });

  test('a branch run tracks its own issue under its own name', async () => {
    const api = failingApi();
    await report(api, { ref: 'refs/heads/ci/probe' });
    expect(api.calls[0]).toContain('failing on ci/probe');
    expect(api.issues[0].body).toContain(trackingMarker('refs/heads/ci/probe'));
  });

  test('dry run reads but performs no mutation', async () => {
    const api = failingApi();
    const lines = await report(api, { dryRun: true });
    expect(api.calls).toEqual([]);
    expect(lines.join('\n')).toContain('dry run: would open an issue');
  });

  test('a failure rehearsal opens the issue without any native job', async () => {
    const api = new FakeNativeWatchApi();
    await report(api, { verdict: 'success', rehearsal: 'failure', ref: BRANCH });
    expect(api.issues[0].body).toContain('rehearsal: no native job ran');
  });

  test('a success rehearsal closes the issue a failure rehearsal opened', async () => {
    const api = new FakeNativeWatchApi();
    await report(api, { rehearsal: 'failure', ref: BRANCH });
    await report(api, { rehearsal: 'success', ref: BRANCH });
    expect(api.issues).toEqual([]);
  });
});

describe('command line', () => {
  test('parses gate and report', () => {
    expect(parseWatchArguments(['gate'])).toEqual({ kind: 'gate' });
    expect(parseWatchArguments(['report', '--verdict', 'failure', '--dry-run'])).toEqual({
      kind: 'report',
      verdict: 'failure',
      dryRun: true,
      rehearsal: undefined,
    });
    expect(
      parseWatchArguments(['report', '--verdict', 'success', '--rehearse', 'failure'])
    ).toMatchObject({ rehearsal: 'failure' });
  });

  test.each([
    [[]],
    [['gate', 'x']],
    [['report']],
    [['report', '--verdict']],
    [['report', '--rehearse', 'maybe']],
  ])('rejects %j', (args) => {
    expect(() => parseWatchArguments(args)).toThrow(/Invalid/);
  });

  test('rejects a verdict outside the four results', () => {
    expect(() => parseNativeVerdict('neutral')).toThrow('Invalid verdict "neutral"');
  });
});

describe('GithubNativeWatchApi', () => {
  function fixture(replies: ScriptedReply[]) {
    const http = new ScriptedGitHubHttp();
    http.replies = replies;
    const environment = new RecordedRetryEnvironment();
    const api = new GithubNativeWatchApi(
      'owner/repo',
      'token',
      (url, init) => http.request(url, init),
      new GitHubRetry(STANDARD_RETRY_POLICY, environment)
    );
    return { api, http, environment };
  }

  test('reads the newest successful scheduled run for a branch', async () => {
    const { api, http } = fixture([
      { status: 200, body: { workflow_runs: [{ head_sha: SHA_A }] } },
    ]);
    expect(await api.lastSuccessfulScheduledSha('native.yml', 'main')).toBe(SHA_A);
    expect(http.calls[0].url.href).toContain(
      '/actions/workflows/native.yml/runs?event=schedule&status=success&branch=main'
    );
  });

  test('lists open issues without pull requests', async () => {
    const { api } = fixture([
      {
        status: 200,
        body: [
          { number: 1, body: 'x', user: { login: 'github-actions[bot]' } },
          { number: 2, body: 'pr', user: { login: 'a' }, pull_request: {} },
        ],
      },
    ]);
    expect(await api.listOpenIssues('type: ci')).toEqual([
      { number: 1, body: 'x', author: 'github-actions[bot]' },
    ]);
  });

  test('names the status and path of a failed request', async () => {
    const { api } = fixture([{ status: 403, body: {} }]);
    await expect(api.closeIssue(5)).rejects.toThrow('PATCH /issues/5 returned 403');
  });

  test('rejects a malformed repository or an empty token before any request', () => {
    expect(() => new GithubNativeWatchApi('nope', 'token')).toThrow('Invalid repository "nope"');
    expect(() => new GithubNativeWatchApi('owner/repo', '')).toThrow('Invalid GITHUB_TOKEN');
  });

  describe('transient failures', () => {
    test('a 502 on the skip-gate read is retried and the later answer is used', async () => {
      const { api, http, environment } = fixture([
        { status: 502, text: 'Bad Gateway' },
        { status: 200, body: { workflow_runs: [{ head_sha: SHA_A }] } },
      ]);
      expect(await api.lastSuccessfulScheduledSha('native.yml', 'main')).toBe(SHA_A);
      expect(http.calls).toHaveLength(2);
      expect(environment.waits).toEqual([5_000]);
    });

    test('a persistent 502 still fails, naming the request and the status', async () => {
      const bad = { status: 502, text: 'Bad Gateway' } as const;
      const { api, http } = fixture([bad, bad, bad]);
      await expect(api.lastSuccessfulScheduledSha('native.yml', 'main')).rejects.toThrow(
        'returned 502; expected a successful response'
      );
      expect(http.calls).toHaveLength(3);
    });

    test('creating an issue is not repeated after a 502, which may have created it', async () => {
      const { api, http } = fixture([{ status: 502 }, { status: 201, body: { number: 9 } }]);
      await expect(
        api.createIssue({ title: 't', body: 'b', labels: ['type: ci'] })
      ).rejects.toThrow('POST /issues returned 502');
      expect(http.calls).toHaveLength(1);
    });

    test('commenting is retried after a rate limit, which GitHub rejects before processing', async () => {
      const { api, http, environment } = fixture([
        { status: 429, headers: { 'retry-after': '8' }, body: { message: 'slow down' } },
        { status: 201, body: {} },
      ]);
      await api.commentOnIssue(5, 'again');
      expect(http.calls).toHaveLength(2);
      expect(environment.waits).toEqual([8_000]);
    });
  });

  describe('duration inside the 9-minute jobs', () => {
    // 9 minutes, less 4 for a Bun setup that retries, less 1 for checkout and step start.
    const SCRIPT_ALLOWANCE_MS = (9 - 4 - 1) * 60_000;

    test('a failing report whose reads each time out twice stays inside the allowance', async () => {
      const timedOut = { networkError: 'The operation timed out' } as const;
      const { api, http, environment } = fixture([
        // open issues, then jobs, then comments: each fails twice and then answers
        timedOut,
        timedOut,
        {
          status: 200,
          body: [
            {
              number: 3,
              body: trackingMarker(MAIN),
              user: { login: 'github-actions[bot]' },
            },
          ],
        },
        timedOut,
        timedOut,
        { status: 200, body: { jobs: [{ name: 'Native candidate', conclusion: 'failure' }] } },
        timedOut,
        timedOut,
        { status: 200, body: [] },
        { status: 201, body: {} },
      ]);
      await reportNativeResult({
        api,
        ref: MAIN,
        sha: SHA_B,
        runId: 7,
        runUrl: RUN_URL,
        verdict: 'failure',
        event: 'schedule',
        dryRun: false,
        log: () => undefined,
      });
      // Four requests made ten attempts; charge each, answered or not, a full timeout.
      const timeouts = http.calls.length * NATIVE_WATCH_REQUEST_TIMEOUT_MS;
      const waited = environment.waits.reduce((sum, wait) => sum + wait, 0);
      expect(http.calls.map(({ init }) => init.method)).toEqual([
        ...Array<string>(9).fill('GET'),
        'POST',
      ]);
      expect(
        timeouts + waited,
        `worst-case ${(timeouts + waited) / 1000} s; expected at most ${SCRIPT_ALLOWANCE_MS / 1000} s`
      ).toBeLessThanOrEqual(SCRIPT_ALLOWANCE_MS);
    });

    test('even when every attempt fails the standard policy bounds the run', () => {
      // A retried attempt waits at least the shortest backoff, so the budget allows
      // this many retries, and the failure that ends the run is one more attempt.
      const retried = Math.floor(
        STANDARD_RETRY_POLICY.maxTotalWaitMs / Math.min(...STANDARD_RETRY_POLICY.backoffMs)
      );
      const worstCaseMs =
        (retried + 1) * NATIVE_WATCH_REQUEST_TIMEOUT_MS + STANDARD_RETRY_POLICY.maxTotalWaitMs;
      expect(
        worstCaseMs,
        `worst-case ${worstCaseMs / 1000} s; expected at most ${SCRIPT_ALLOWANCE_MS / 1000} s`
      ).toBeLessThanOrEqual(SCRIPT_ALLOWANCE_MS);
    });
  });

  describe('malformed answers fail closed', () => {
    test.each([
      { name: 'an object instead of an array', body: { message: 'Server Error' } },
      { name: 'null', body: null },
    ])('an issue listing that is $name is an error, not an empty listing', async ({ body }) => {
      const { api } = fixture([{ status: 200, body }]);
      await expect(api.listOpenIssues('type: ci')).rejects.toThrow(
        'Invalid GET /issues?state=open&labels=type%3A+ci page 1; expected a JSON array | received '
      );
    });

    test('a comment listing that is not an array names the issue, the page and the body', async () => {
      const { api } = fixture([{ status: 200, body: { message: 'Not Found' } }]);
      await expect(api.listIssueCommentBodies(7)).rejects.toThrow(
        'Invalid GET /issues/7/comments page 1; expected a JSON array | received {"message":"Not Found"}'
      );
    });

    test('a job listing without a jobs array is an error on the page that was read', async () => {
      const { api } = fixture([
        {
          status: 200,
          body: { total_count: 100, jobs: Array.from({ length: 100 }, () => ({ name: 'a' })) },
        },
        { status: 200, body: { total_count: 0 } },
      ]);
      await expect(api.listJobs(7)).rejects.toThrow(
        'page 2; expected an object with a "jobs" array | received {"total_count":0}'
      );
    });

    test('a non-JSON 200 names the request and the body instead of a bare parse error', async () => {
      const { api } = fixture([{ status: 200, text: '<!DOCTYPE html><html>Unicorn</html>' }]);
      const failure = await api.listOpenIssues('type: ci').catch((error: Error) => error);
      expect((failure as Error).message).not.toContain('JSON Parse error');
      expect((failure as Error).message).toContain(
        'expected a JSON array as JSON (HTTP 200) | received <!DOCTYPE html><html>Unicorn</html>'
      );
    });
  });
});

describe('workflow wiring', () => {
  type Job = {
    permissions?: Record<string, string>;
    needs?: string[] | string;
    'runs-on'?: string;
  };
  const load = (file: string) =>
    Bun.YAML.parse(readText(file)) as {
      on: Record<string, unknown>;
      jobs: Record<string, Job>;
    };

  test('the native workflow is scheduled daily and grants issues: write to the report job only', () => {
    const workflow = load('.github/workflows/native-bun-qualification.yml');
    expect(workflow.on.schedule).toEqual([{ cron: '43 8 * * *' }]);
    const writers = Object.entries(workflow.jobs)
      .filter(([, job]) => job.permissions?.issues === 'write')
      .map(([name]) => name);
    expect(writers).toEqual(['report']);
  });

  test('only a schedule or a rehearsal reports, and a person-cancelled run does not', () => {
    const workflow = load('.github/workflows/native-bun-qualification.yml') as {
      jobs: Record<string, { if?: string; steps?: { name?: string; if?: string }[] }>;
    };
    const report = workflow.jobs.report;
    expect(report.if).toContain("github.event_name == 'schedule'");
    expect(report.if).toContain("inputs.rehearse != ''");
    expect(report.if).not.toContain("!= 'pull_request'");
    const step = report.steps?.find((candidate) => candidate.name?.startsWith('Open, update'));
    expect(step?.if, 'a timed-out job is cancelled, so only cancelled() may skip the report').toBe(
      '$' + '{{ !cancelled() }}'
    );
  });

  test('the Windows pull-request workflow is path-filtered and sits behind no gate', () => {
    const file = '.github/workflows/windows-pr-tests.yml';
    const workflow = load(file);
    const paths = (workflow.on.pull_request as { paths: string[] }).paths;
    for (const required of [
      'apps/api/**',
      'apps/shared/**',
      'scripts/**',
      'packages/**',
      'bun.lock',
      'package.json',
      '.bun-version',
      'crates/**',
      '.github/actions/setup-mango/**',
      '.github/actions/local-runtime/**',
      '.github/workflows/windows-pr-tests.yml',
    ]) {
      expect(paths, `${file} paths`).toContain(required);
    }
    expect(Object.values(workflow.jobs).map((job) => job['runs-on'])).toEqual(['windows-latest']);
    // Advisory: no aggregate gate may wait for it, or it would become a merge condition.
    for (const other of workflowFiles().filter((candidate) => candidate !== file)) {
      const needs = Object.values(load(other).jobs).flatMap((job) => [job.needs ?? []].flat());
      expect(needs, `${other} needs`).not.toContain('windows-tests');
    }
  });

  test('the Windows pull-request lanes get their temp directory from the runner temp volume', () => {
    const file = '.github/workflows/windows-pr-tests.yml';
    const workflow = Bun.YAML.parse(readText(file)) as {
      jobs: Record<string, { steps: { name?: string; run?: string; uses?: string }[] }>;
    };
    const steps = workflow.jobs['windows-tests']?.steps ?? [];
    const names = steps.map((step) => step.name ?? '');
    const tempStep = steps.find(
      (step) => step.name === 'Keep test fixtures on the workspace volume'
    );
    expect(tempStep, `${file} steps: ${names.join(' | ')}`).toBeDefined();
    // os.tmpdir() reads TEMP, then TMP, on Windows: both must follow RUNNER_TEMP.
    for (const variable of ['TEMP', 'TMP']) {
      expect(tempStep?.run, `${file} ${variable} export`).toContain(
        `printf '${variable}=%s\\n' "$RUNNER_TEMP" >> "$GITHUB_ENV"`
      );
    }
    const tempIndex = names.indexOf('Keep test fixtures on the workspace volume');
    for (const lane of ['API unit lane', 'Root scripts lane']) {
      expect(
        tempIndex,
        `${file}: expected the temp step before "${lane}" | received steps: ${names.join(' | ')}`
      ).toBeLessThan(names.indexOf(lane));
    }
    // Setup and the runtime build keep the runner default; only the lanes move.
    const runtimeBuildIndex = steps.findIndex((step) => step.uses?.includes('local-runtime'));
    expect(runtimeBuildIndex, `${file}: expected a local-runtime step`).toBeGreaterThanOrEqual(0);
    expect(tempIndex, `${file}: expected the temp step after the runtime build`).toBeGreaterThan(
      runtimeBuildIndex
    );
  });
});
