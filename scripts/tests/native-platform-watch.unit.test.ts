import { describe, expect, test } from 'bun:test';

import { parseWatchArguments } from '../ci/native-platform-watch';
import { GithubNativeWatchApi } from '../ci/native-watch/api';
import {
  parseNativeVerdict,
  reportNativeResult,
  shouldSkipScheduledRun,
  trackingMarker,
} from '../ci/native-watch/decide';
import { FakeNativeWatchApi } from './support/fake-native-watch-api';
import { readText } from './support/read-text';
import { workflowFiles } from './support/workflow-files';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const MAIN = 'refs/heads/main';
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
    { name: 'Native candidate (ubuntu-latest)', conclusion: 'timed_out' },
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
    expect(body).toContain('- Native candidate (ubuntu-latest): timed_out');
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

  test.each(['cancelled', 'skipped'] as const)(
    'a %s run leaves the issue alone',
    async (verdict) => {
      const api = failingApi();
      await report(api);
      await report(api, { verdict });
      expect(api.calls).toHaveLength(1);
    }
  );

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
    await report(api, { verdict: 'success', rehearsal: 'failure' });
    expect(api.issues[0].body).toContain('rehearsal: no native job ran');
  });

  test('a success rehearsal closes the issue a failure rehearsal opened', async () => {
    const api = new FakeNativeWatchApi();
    await report(api, { rehearsal: 'failure' });
    await report(api, { rehearsal: 'success' });
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
  function respond(body: unknown, status = 200): Response {
    return new Response(status === 204 ? null : JSON.stringify(body), { status });
  }

  test('reads the newest successful scheduled run for a branch', async () => {
    const urls: string[] = [];
    const api = new GithubNativeWatchApi('owner/repo', 'token', (url) => {
      urls.push(url);
      return Promise.resolve(respond({ workflow_runs: [{ head_sha: SHA_A }] }));
    });
    expect(await api.lastSuccessfulScheduledSha('native.yml', 'main')).toBe(SHA_A);
    expect(urls[0]).toContain(
      '/actions/workflows/native.yml/runs?event=schedule&status=success&branch=main'
    );
  });

  test('lists open issues without pull requests', async () => {
    const api = new GithubNativeWatchApi('owner/repo', 'token', () =>
      Promise.resolve(
        respond([
          { number: 1, body: 'x', user: { login: 'github-actions[bot]' } },
          { number: 2, body: 'pr', user: { login: 'a' }, pull_request: {} },
        ])
      )
    );
    expect(await api.listOpenIssues('type: ci')).toEqual([
      { number: 1, body: 'x', author: 'github-actions[bot]' },
    ]);
  });

  test('names the status and path of a failed request', async () => {
    const api = new GithubNativeWatchApi('owner/repo', 'token', () =>
      Promise.resolve(respond({}, 403))
    );
    await expect(api.closeIssue(5)).rejects.toThrow('PATCH /issues/5 returned 403');
  });

  test('rejects a malformed repository or an empty token before any request', () => {
    expect(() => new GithubNativeWatchApi('nope', 'token')).toThrow('Invalid repository "nope"');
    expect(() => new GithubNativeWatchApi('owner/repo', '')).toThrow('Invalid GITHUB_TOKEN');
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

  test('the Windows pull-request workflow is path-filtered and sits behind no gate', () => {
    const file = '.github/workflows/windows-pr-tests.yml';
    const workflow = load(file);
    const paths = (workflow.on.pull_request as { paths: string[] }).paths;
    for (const required of ['apps/api/**', 'apps/shared/**', 'scripts/**', 'packages/**']) {
      expect(paths, `${file} paths`).toContain(required);
    }
    expect(Object.values(workflow.jobs).map((job) => job['runs-on'])).toEqual(['windows-latest']);
    // Advisory: no aggregate gate may wait for it, or it would become a merge condition.
    for (const other of workflowFiles().filter((candidate) => candidate !== file)) {
      const needs = Object.values(load(other).jobs).flatMap((job) => [job.needs ?? []].flat());
      expect(needs, `${other} needs`).not.toContain('windows-tests');
    }
  });
});
