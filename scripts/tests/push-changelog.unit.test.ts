import { describe, expect, test } from 'bun:test';

import type { CaptureResult } from '../lib/exec';
import {
  type CommandRunner,
  changelogBranchName,
  commitMessage,
  landChangelog,
  parsePushChangelogArgs,
  pullRequestBody,
  pullRequestTitle,
} from '../release/push-changelog';

const BASE_SHA = 'base-sha-0000000000000000000000000000000000000000';
const OLD_CHANGELOG = '# Changelog\n\nInitial.\n';
const NEW_CHANGELOG = '# Changelog\n\nUpdated for 1.2.3.\n';
const OLD_BLOB_SHA = 'old-blob-sha';

const toBase64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');

const ok = (stdout = ''): CaptureResult => ({ stdout, stderr: '', exitCode: 0 });
const fail = (stderr: string, exitCode = 1): CaptureResult => ({ stdout: '', stderr, exitCode });

/** A gh stub that records every invocation and replies per a lookup keyed on
 * the REST method + endpoint, mirroring the real `gh api` call shape. */
const ghStub = (
  overrides: Record<string, CaptureResult> = {}
): { run: CommandRunner; calls: string[][] } => {
  const calls: string[][] = [];
  const commandKey = (args: readonly string[]): string => {
    if (args[0] !== 'api') return `${args[0]} ${args[1]}`;
    const methodIndex = args.indexOf('--method');
    const method = methodIndex >= 0 ? (args[methodIndex + 1] ?? 'GET') : 'GET';
    const endpoint = args.find((arg) => arg.startsWith('repos/')) ?? '';
    return `api ${method} ${endpoint}`;
  };
  const run: CommandRunner = (args) => {
    calls.push([...args]);
    const key = commandKey(args);
    if (key in overrides) return Promise.resolve(overrides[key]);
    if (key === 'api GET repos/{owner}/{repo}/git/ref/heads/main')
      return Promise.resolve(ok(`${BASE_SHA}\n`));
    if (key === 'api GET repos/{owner}/{repo}/contents/CHANGELOG.md') {
      return Promise.resolve(
        ok(`${JSON.stringify({ sha: OLD_BLOB_SHA, content: toBase64(OLD_CHANGELOG) })}\n`)
      );
    }
    if (key === 'api POST repos/{owner}/{repo}/git/refs') return Promise.resolve(ok());
    if (key.startsWith('api PATCH repos/{owner}/{repo}/git/refs/heads/'))
      return Promise.resolve(ok());
    if (key === 'api PUT repos/{owner}/{repo}/contents/CHANGELOG.md') return Promise.resolve(ok());
    if (key === 'api GET repos/{owner}/{repo}/pulls') return Promise.resolve(ok('0\n'));
    if (key === 'api POST repos/{owner}/{repo}/pulls') {
      return Promise.resolve(ok('https://github.com/example/mangostudio/pull/1\n'));
    }
    return Promise.resolve(ok());
  };
  return { run, calls };
};

const findApiCall = (
  calls: string[][],
  method: string,
  endpointPrefix: string
): string[] | undefined =>
  calls.find(
    (call) =>
      call[0] === 'api' &&
      call.includes(method) &&
      call.some((arg) => arg.startsWith('repos/') && arg.startsWith(endpointPrefix))
  );

const fieldValue = (call: string[], field: string): string | undefined => {
  for (let i = 0; i < call.length; i += 1) {
    if (
      (call[i] === '--raw-field' || call[i] === '--field') &&
      call[i + 1]?.startsWith(`${field}=`)
    ) {
      return call[i + 1]?.slice(field.length + 1);
    }
  }
  return undefined;
};

describe('parsePushChangelogArgs', () => {
  test('parses version and defaults the branch to main', () => {
    expect(parsePushChangelogArgs(['--version', '1.2.3'])).toEqual({
      version: '1.2.3',
      branch: 'main',
    });
  });

  test('strips a leading v and honors an explicit branch', () => {
    expect(parsePushChangelogArgs(['--version', 'v1.2.3', '--branch', 'release'])).toEqual({
      version: '1.2.3',
      branch: 'release',
    });
  });

  test('accepts prerelease versions', () => {
    expect(parsePushChangelogArgs(['--version', '0.0.0-dryrun']).version).toBe('0.0.0-dryrun');
  });

  test('rejects unknown flags, missing values, and unsafe versions', () => {
    expect(() => parsePushChangelogArgs(['--nope', 'x'])).toThrow(/Unknown argument/);
    expect(() => parsePushChangelogArgs(['--version'])).toThrow(/Missing value/);
    expect(() => parsePushChangelogArgs(['--branch', 'main'])).toThrow(/--version is required/);
    expect(() => parsePushChangelogArgs(['--version', '../evil'])).toThrow(/Invalid --version/);
    expect(() => parsePushChangelogArgs(['--version', '1.0; rm -rf'])).toThrow(/Invalid --version/);
  });
});

describe('message builders', () => {
  test('commit message carries a chore(release) subject and a DCO trailer', () => {
    const message = commitMessage('1.2.3');
    expect(message).toContain('chore(release): update changelog for v1.2.3');
    expect(message).toContain(
      'Signed-off-by: github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>'
    );
  });

  test('PR title mirrors the commit subject so cliff.toml skips it too', () => {
    expect(pullRequestTitle('1.2.3')).toBe('chore(release): update changelog for v1.2.3');
  });

  test('branch name and PR body reference the version', () => {
    expect(changelogBranchName('1.2.3')).toBe('chore/changelog-v1.2.3');
    expect(pullRequestBody('1.2.3')).toContain('`v1.2.3`');
    expect(pullRequestBody('1.2.3')).toContain('merge commit');
  });
});

describe('landChangelog', () => {
  test('no-ops when the base branch already has the regenerated changelog', async () => {
    const ghActions = ghStub();
    const ghPr = ghStub();

    const result = await landChangelog({
      version: '1.2.3',
      baseBranch: 'main',
      newChangelog: OLD_CHANGELOG,
      ghActions: ghActions.run,
      ghPr: ghPr.run,
    });

    expect(result).toBe('up-to-date');
    expect(ghActions.calls.some((call) => call[0] === 'api' && call.includes('PUT'))).toBe(false);
    expect(ghPr.calls).toHaveLength(0);
  });

  test('commits via the Contents API and opens a PR when the changelog changed', async () => {
    const ghActions = ghStub();
    const ghPr = ghStub();

    const result = await landChangelog({
      version: '1.2.3',
      baseBranch: 'main',
      newChangelog: NEW_CHANGELOG,
      ghActions: ghActions.run,
      ghPr: ghPr.run,
    });

    expect(result).toBe('pull-request');

    const createBranch = findApiCall(ghActions.calls, 'POST', 'repos/{owner}/{repo}/git/refs');
    expect(createBranch).toBeDefined();
    expect(fieldValue(createBranch as string[], 'ref')).toBe('refs/heads/chore/changelog-v1.2.3');
    expect(fieldValue(createBranch as string[], 'sha')).toBe(BASE_SHA);

    const commit = findApiCall(
      ghActions.calls,
      'PUT',
      'repos/{owner}/{repo}/contents/CHANGELOG.md'
    );
    expect(commit).toBeDefined();
    expect(fieldValue(commit as string[], 'branch')).toBe('chore/changelog-v1.2.3');
    expect(fieldValue(commit as string[], 'sha')).toBe(OLD_BLOB_SHA);
    expect(fieldValue(commit as string[], 'content')).toBe(toBase64(NEW_CHANGELOG));
    const committedMessage = fieldValue(commit as string[], 'message') ?? '';
    expect(committedMessage).toContain('chore(release): update changelog for v1.2.3');
    expect(committedMessage).toContain('Signed-off-by: github-actions[bot]');

    const createPr = findApiCall(ghPr.calls, 'POST', 'repos/{owner}/{repo}/pulls');
    expect(createPr).toBeDefined();
    expect(fieldValue(createPr as string[], 'base')).toBe('main');
    expect(fieldValue(createPr as string[], 'head')).toBe('chore/changelog-v1.2.3');
    expect(fieldValue(createPr as string[], 'title')).toBe(
      'chore(release): update changelog for v1.2.3'
    );

    // Never merges the PR it opens.
    expect(ghPr.calls.some((call) => call[0] === 'api' && call.includes('PUT'))).toBe(false);
    expect(ghPr.calls.some((call) => call.includes('merge'))).toBe(false);
  });

  test('commits without a blob sha when CHANGELOG.md does not exist yet', async () => {
    const ghActions = ghStub({
      'api GET repos/{owner}/{repo}/contents/CHANGELOG.md': fail('gh: Not Found (HTTP 404)', 1),
    });
    const ghPr = ghStub();

    const result = await landChangelog({
      version: '1.2.3',
      baseBranch: 'main',
      newChangelog: NEW_CHANGELOG,
      ghActions: ghActions.run,
      ghPr: ghPr.run,
    });

    expect(result).toBe('pull-request');
    const commit = findApiCall(
      ghActions.calls,
      'PUT',
      'repos/{owner}/{repo}/contents/CHANGELOG.md'
    );
    expect(fieldValue(commit as string[], 'sha')).toBeUndefined();
  });

  test('resets an already-existing changelog branch instead of failing', async () => {
    const ghActions = ghStub({
      'api POST repos/{owner}/{repo}/git/refs': fail('gh: Reference already exists (HTTP 422)', 1),
    });
    const ghPr = ghStub();

    const result = await landChangelog({
      version: '1.2.3',
      baseBranch: 'main',
      newChangelog: NEW_CHANGELOG,
      ghActions: ghActions.run,
      ghPr: ghPr.run,
    });

    expect(result).toBe('pull-request');
    const reset = findApiCall(
      ghActions.calls,
      'PATCH',
      'repos/{owner}/{repo}/git/refs/heads/chore/changelog-v1.2.3'
    );
    expect(reset).toBeDefined();
    expect(fieldValue(reset as string[], 'sha')).toBe(BASE_SHA);
    expect(fieldValue(reset as string[], 'force')).toBe('true');
  });

  test('reuses an existing open PR instead of creating a duplicate', async () => {
    const ghActions = ghStub();
    const ghPr = ghStub({
      'api GET repos/{owner}/{repo}/pulls': ok('1\n'),
    });

    const result = await landChangelog({
      version: '1.2.3',
      baseBranch: 'main',
      newChangelog: NEW_CHANGELOG,
      ghActions: ghActions.run,
      ghPr: ghPr.run,
    });

    expect(result).toBe('pull-request');
    expect(ghPr.calls.some((call) => call[0] === 'api' && call.includes('POST'))).toBe(false);
  });

  test('reuses an open PR found on a later page of paginated results', async () => {
    const ghActions = ghStub();
    // `gh api --paginate` runs the jq per page and concatenates: the head branch
    // matches on the second page (0 on the first), so the counts must be summed.
    const ghPr = ghStub({
      'api GET repos/{owner}/{repo}/pulls': ok('0\n1\n'),
    });

    const result = await landChangelog({
      version: '1.2.3',
      baseBranch: 'main',
      newChangelog: NEW_CHANGELOG,
      ghActions: ghActions.run,
      ghPr: ghPr.run,
    });

    expect(result).toBe('pull-request');
    expect(ghPr.calls.some((call) => call[0] === 'api' && call.includes('POST'))).toBe(false);
  });

  test('explains the required token when REST PR creation is denied', async () => {
    const ghActions = ghStub();
    const ghPr = ghStub({
      'api POST repos/{owner}/{repo}/pulls': fail('Resource not accessible by integration', 1),
    });

    await expect(
      landChangelog({
        version: '1.2.3',
        baseBranch: 'main',
        newChangelog: NEW_CHANGELOG,
        ghActions: ghActions.run,
        ghPr: ghPr.run,
      })
    ).rejects.toThrow(/CHANGELOG_PR_TOKEN/);

    // The commit already landed on the changelog branch before the PR step ran.
    const commit = findApiCall(
      ghActions.calls,
      'PUT',
      'repos/{owner}/{repo}/contents/CHANGELOG.md'
    );
    expect(commit).toBeDefined();
  });
});
