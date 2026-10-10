import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { link, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildFakeGh,
  FAKE_GH_EXECUTABLE_NAME,
  type FakeGhInstallDependencies,
  installFakeGh,
} from '../../support/fake-gh/install';
import {
  DEFAULT_PR_OUTPUT,
  DEFAULT_REPO_OUTPUT,
  FAKE_GH_MISSING_SCENARIO_EXIT,
  FAKE_GH_SCENARIO_FILE,
  fakeGhReply,
} from '../../support/fake-gh/program';

/** The real hard link, with every request it was asked for. */
class RecordingLink implements FakeGhInstallDependencies {
  readonly calls: [string, string][] = [];
  readonly link = async (existing: string, target: string): Promise<void> => {
    this.calls.push([existing, target]);
    await link(existing, target);
  };
}

/** A file system that cannot hard link: another volume (`EXDEV`), or one without the right. */
class RefusingLink implements FakeGhInstallDependencies {
  attempts = 0;
  constructor(private readonly code: string) {}
  readonly link = (): Promise<void> => {
    this.attempts += 1;
    return Promise.reject(
      Object.assign(new Error(`${this.code}: link refused`), { code: this.code })
    );
  };
}

const AUTH = ['auth', 'status', '--json', 'hosts'];
const REPO = ['repo', 'view', '--json', 'nameWithOwner,defaultBranchRef,url'];
const PR = ['pr', 'view', '--json', 'number,title,state,isDraft,url,headRefName,baseRefName'];

describe('fakeGhReply', () => {
  test('answers the version probe with a parseable gh version', () => {
    const reply = fakeGhReply(['--version'], {});

    expect(reply.exitCode).toBe(0);
    expect(reply.stdout).toStartWith('gh version 2.97.0');
  });

  test('reports an active host unless the scenario says the user is logged out', () => {
    expect(JSON.parse(fakeGhReply(AUTH, {}).stdout).hosts['github.example'][0].state).toBe(
      'success'
    );

    const loggedOut = fakeGhReply(AUTH, { authenticated: false });
    expect(JSON.parse(loggedOut.stdout)).toEqual({ hosts: {} });
    expect(loggedOut.stderr).toBe('not logged in\n');
    expect(loggedOut.exitCode).toBe(0);
  });

  test('prints the default repository and pull request unless the scenario overrides them', () => {
    expect(fakeGhReply(REPO, {}).stdout).toBe(`${DEFAULT_REPO_OUTPUT}\n`);
    expect(fakeGhReply(PR, {}).stdout).toBe(`${DEFAULT_PR_OUTPUT}\n`);
    expect(fakeGhReply(REPO, { repoStdout: '{not-json' }).stdout).toBe('{not-json\n');
    expect(fakeGhReply(PR, { prStdout: '{}' }).stdout).toBe('{}\n');
  });

  test('fails a repository or pull request call with the scenario stderr and nothing on stdout', () => {
    const repo = fakeGhReply(REPO, { repoStderr: 'no git remotes found' });
    const pr = fakeGhReply(PR, { prStderr: 'no pull requests found' });

    expect(repo).toEqual({ stdout: '', stderr: 'no git remotes found\n', exitCode: 1 });
    expect(pr).toEqual({ stdout: '', stderr: 'no pull requests found\n', exitCode: 1 });
  });

  test('exits 127 for every call when the scenario is unusable', () => {
    for (const args of [['--version'], AUTH, REPO, PR]) {
      expect(fakeGhReply(args, { unusable: true }).exitCode).toBe(127);
    }
  });

  test('exits 64 and names an argv it was not scripted for', () => {
    const reply = fakeGhReply(['pr', 'list'], {});

    expect(reply.exitCode).toBe(64);
    expect(reply.stderr).toContain('unexpected gh command: pr list');
  });
});

describe('compiled fake gh', () => {
  let work: string;
  let built: string;

  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), 'mango-fake-gh-test-'));
    // One build writes an executable the size of Bun, which Windows also scans on first write.
    built = await buildFakeGh(work);
  }, 60_000);

  afterAll(async () => {
    await rm(work, { recursive: true, force: true });
  });

  async function run(directory: string, args: readonly string[]) {
    const child = Bun.spawn([join(directory, FAKE_GH_EXECUTABLE_NAME), ...args], {
      cwd: work,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, exitCode };
  }

  test('runs as an executable named gh and answers from the scenario beside it', async () => {
    const directory = await installFakeGh(
      built,
      { repoStderr: 'no git remotes found' },
      await mkdtemp(join(work, 'bin-'))
    );

    const version = await run(directory, ['--version']);
    const repo = await run(directory, REPO);

    expect(
      version.exitCode,
      `expected exit 0 | received: ${version.exitCode} ${version.stderr}`
    ).toBe(0);
    expect(version.stdout).toStartWith('gh version 2.97.0');
    expect(repo).toEqual({ stdout: '', stderr: 'no git remotes found\n', exitCode: 1 });
  });

  test('keeps two installed scenarios independent', async () => {
    const [loggedOut, loggedIn] = await Promise.all([
      installFakeGh(built, { authenticated: false }, await mkdtemp(join(work, 'bin-'))),
      installFakeGh(built, {}, await mkdtemp(join(work, 'bin-'))),
    ]);

    expect(JSON.parse((await run(loggedOut, AUTH)).stdout)).toEqual({ hosts: {} });
    expect(Object.keys(JSON.parse((await run(loggedIn, AUTH)).stdout).hosts)).toEqual([
      'github.example',
    ]);
  });

  test('installs the template as a hard link instead of writing its bytes again', async () => {
    const linking = new RecordingLink();
    const directory = await installFakeGh(built, {}, await mkdtemp(join(work, 'bin-')), linking);

    expect(
      linking.calls,
      `expected one hard link from the template | received: ${linking.calls.length} link calls`
    ).toEqual([[built, join(directory, FAKE_GH_EXECUTABLE_NAME)]]);
    expect((await run(directory, ['--version'])).exitCode).toBe(0);
  });

  test('copies the template when the file system refuses the hard link', async () => {
    const refusing = new RefusingLink('EXDEV');
    const directory = await installFakeGh(
      built,
      { authenticated: false },
      await mkdtemp(join(work, 'bin-')),
      refusing
    );

    expect(refusing.attempts).toBe(1);
    const auth = await run(directory, AUTH);
    expect(
      auth.exitCode,
      `expected the copied fake to run: exit 0 | received: ${auth.exitCode} ${auth.stderr}`
    ).toBe(0);
    expect(JSON.parse(auth.stdout)).toEqual({ hosts: {} });
  });

  test('reports a missing scenario file rather than guessing one', async () => {
    const directory = await installFakeGh(built, {}, await mkdtemp(join(work, 'bin-')));
    await rm(join(directory, FAKE_GH_SCENARIO_FILE));

    const result = await run(directory, ['--version']);

    expect(result.exitCode).toBe(FAKE_GH_MISSING_SCENARIO_EXIT);
    expect(result.stderr).toContain('scenario unreadable');
  });

  test('reports a scenario file that is not JSON', async () => {
    const directory = await installFakeGh(built, {}, await mkdtemp(join(work, 'bin-')));
    await writeFile(join(directory, FAKE_GH_SCENARIO_FILE), '{not-json');

    const result = await run(directory, ['--version']);

    expect(result.exitCode).toBe(FAKE_GH_MISSING_SCENARIO_EXIT);
    expect(result.stderr).toContain('scenario unreadable');
  });
});
