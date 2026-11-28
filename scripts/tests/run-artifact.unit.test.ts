import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { zipCreationCommand } from '../lib/archive-creation';
import { ROOT_DIR } from '../lib/config';
import { ARTIFACT_DOWNLOAD_RETRY_POLICY, GitHubRetry } from '../lib/github-retry';
import {
  ARCHIVE_TIMEOUT_MS,
  assertSafeZipEntries,
  type BoundedRunner,
  DOWNLOAD_ATTEMPTS,
  downloadRunArtifact,
  fetchArtifactZip,
  findRunArtifact,
  METADATA_TIMEOUT_MS,
  runBounded,
  selectRunArtifact,
} from '../lib/run-artifact';
import { zipCreationUnavailable } from './support/host-tools';
import { RecordedRetryEnvironment } from './support/scripted-github-http';
import { extractStepBlocksUsing } from './support/workflow-blocks';

// Skipped on a developer machine without `zip`; CI throws instead (see host-tools.ts).
const ZIP_UNAVAILABLE = zipCreationUnavailable();

const DIGEST = `sha256:${'a'.repeat(64)}`;
const RUN_ID = 42;

function listing(overrides: Record<string, unknown> = {}) {
  return {
    artifacts: [
      {
        id: 7,
        name: 'hub-inputs-abc',
        digest: DIGEST,
        expired: false,
        workflow_run: { id: RUN_ID },
        ...overrides,
      },
    ],
  };
}

describe('selectRunArtifact', () => {
  test('returns the id and recorded digest of the one live artifact', () => {
    expect(selectRunArtifact(listing(), 'hub-inputs-abc', RUN_ID)).toEqual({
      id: 7,
      digest: DIGEST,
    });
  });

  test.each([
    ['no match', { artifacts: [] }, 'expected exactly one | received 0'],
    [
      'a duplicate',
      { artifacts: [...listing().artifacts, ...listing().artifacts] },
      'expected exactly one | received 2',
    ],
    ['an expired artifact', listing({ expired: true }), 'expected unexpired | received expired'],
    [
      'another run',
      listing({ workflow_run: { id: 9 } }),
      `workflow run: expected ${RUN_ID} | received 9`,
    ],
    ['no digest', listing({ digest: null }), 'expected sha256:<64 lowercase hex> | received null'],
    ['a short digest', listing({ digest: 'sha256:abc' }), 'received sha256:abc'],
  ])('rejects %s', (_label, input, message) => {
    expect(() => selectRunArtifact(input, 'hub-inputs-abc', RUN_ID)).toThrow(message);
  });
});

describe('assertSafeZipEntries', () => {
  test('accepts relative entries and directories', () => {
    expect(() => assertSafeZipEntries(['a.txt', 'dir/', 'dir/b.txt'])).not.toThrow();
  });

  test.each(['/etc/passwd', '../escape', 'a/../../b', 'C:/windows', 'a\\b', ''])(
    'rejects %j',
    (entry) => {
      expect(() => assertSafeZipEntries([entry])).toThrow(
        `expected a relative path inside the archive | received ${JSON.stringify(entry)}`
      );
    }
  );
});

function fakeRunner(
  outcome: (
    call: number,
    command: readonly string[],
    stdoutFile?: string
  ) => {
    exitCode?: number;
    timedOut?: boolean;
    stdout?: string;
  }
): { run: BoundedRunner; commands: (readonly string[])[] } {
  const commands: (readonly string[])[] = [];
  const run: BoundedRunner = (command, options) => {
    commands.push(command);
    const result = outcome(commands.length, command, options.stdoutFile);
    return Promise.resolve({
      exitCode: result.exitCode ?? 0,
      timedOut: result.timedOut ?? false,
      stdout: result.stdout ?? '',
    });
  };
  return { run, commands };
}

describe('findRunArtifact', () => {
  test('asks the run for one artifact name under the metadata bound', async () => {
    const seen: number[] = [];
    const run: BoundedRunner = (command, options) => {
      seen.push(options.timeoutMs);
      expect(command.join(' ')).toContain(`repos/o/r/actions/runs/${RUN_ID}/artifacts`);
      expect(command).toContain('name=hub-inputs-abc');
      return Promise.resolve({ exitCode: 0, timedOut: false, stdout: JSON.stringify(listing()) });
    };
    expect(
      await findRunArtifact({ repository: 'o/r', runId: RUN_ID, name: 'hub-inputs-abc', run })
    ).toEqual({
      id: 7,
      digest: DIGEST,
    });
    expect(seen).toEqual([METADATA_TIMEOUT_MS]);
  });

  test.each([
    {
      name: 'non-JSON output',
      stdout: '<html>Unicorn</html>',
      expected: 'an artifact listing object as JSON | received <html>Unicorn</html>',
    },
    {
      name: 'an object without artifacts',
      stdout: '{"message":"Not Found"}',
      expected: 'an object with an "artifacts" array | received {"message":"Not Found"}',
    },
  ])('names the request and the body for $name', async ({ stdout, expected }) => {
    const { run } = fakeRunner(() => ({ exitCode: 0, stdout }));
    await expect(
      findRunArtifact({ repository: 'o/r', runId: RUN_ID, name: 'x', run })
    ).rejects.toThrow(`Invalid GET runs/${RUN_ID}/artifacts; expected ${expected}`);
  });

  test('names a timed-out listing', async () => {
    const { run } = fakeRunner(() => ({ timedOut: true, exitCode: 1 }));
    await expect(
      findRunArtifact({ repository: 'o/r', runId: RUN_ID, name: 'x', run })
    ).rejects.toThrow(`Run ${RUN_ID} artifact list: timed out after ${METADATA_TIMEOUT_MS} ms`);
  });
});

describe('fetchArtifactZip', () => {
  const base = { repository: 'o/r', artifactId: 7, digest: DIGEST, archive: 'artifact.zip' };

  test('accepts bytes that match the digest and fetches the ZIP under the archive bound', async () => {
    const timeouts: number[] = [];
    const run: BoundedRunner = (command, options) => {
      timeouts.push(options.timeoutMs);
      expect(command.join(' ')).toBe('gh api repos/o/r/actions/artifacts/7/zip');
      expect(options.stdoutFile).toBe('artifact.zip');
      return Promise.resolve({ exitCode: 0, timedOut: false, stdout: '' });
    };
    await fetchArtifactZip({ ...base, run, digestOf: () => Promise.resolve(DIGEST) });
    expect(timeouts).toEqual([ARCHIVE_TIMEOUT_MS]);
  });

  test('rejects bytes whose digest differs', async () => {
    const { run } = fakeRunner(() => ({}));
    const other = `sha256:${'b'.repeat(64)}`;
    await expect(
      fetchArtifactZip({ ...base, run, digestOf: () => Promise.resolve(other) })
    ).rejects.toThrow(`Artifact 7 ZIP digest: expected ${DIGEST} | received ${other}`);
  });

  test('names a stalled transfer and a failed one', async () => {
    await expect(
      fetchArtifactZip({ ...base, run: fakeRunner(() => ({ timedOut: true, exitCode: 1 })).run })
    ).rejects.toThrow(`Artifact 7: download timed out after ${ARCHIVE_TIMEOUT_MS} ms`);
    await expect(
      fetchArtifactZip({ ...base, run: fakeRunner(() => ({ exitCode: 4 })).run })
    ).rejects.toThrow('Artifact 7: download failed with exit code 4');
  });
});

describe('runBounded', () => {
  test('kills a process that outlives its bound instead of waiting for it', async () => {
    const started = Date.now();
    const result = await runBounded(['bun', '-e', 'setTimeout(() => {}, 60000)'], {
      timeoutMs: 300,
    });
    expect(result.timedOut, 'a 60 s sleeper with a 300 ms bound').toBe(true);
    expect(Date.now() - started, 'elapsed ms until the sleeper was killed').toBeLessThan(15_000);
  });

  test('captures stdout of a process that finishes in time', async () => {
    const result = await runBounded(['bun', '-e', 'console.log("ready")'], { timeoutMs: 30_000 });
    expect(result).toEqual({ exitCode: 0, timedOut: false, stdout: 'ready\n' });
  });
});

describe('download retry budget', () => {
  test('keeps both attempts and the pause between them inside the 3-minute step deadline callers declare', () => {
    expect(DOWNLOAD_ATTEMPTS).toBe(2);
    const worstCaseMs =
      DOWNLOAD_ATTEMPTS * (METADATA_TIMEOUT_MS + ARCHIVE_TIMEOUT_MS) +
      ARTIFACT_DOWNLOAD_RETRY_POLICY.maxTotalWaitMs;
    expect(worstCaseMs).toBe(172_000);
    expect(worstCaseMs).toBeLessThanOrEqual(180_000);
  });

  // A step deadline below the client's worst case kills a download that would
  // have succeeded on its last attempt, and hides the client's error.
  test('every workflow step that downloads a run artifact outlasts the client worst case', () => {
    const worstCaseMinutes = Math.ceil(
      (DOWNLOAD_ATTEMPTS * (METADATA_TIMEOUT_MS + ARCHIVE_TIMEOUT_MS) +
        ARTIFACT_DOWNLOAD_RETRY_POLICY.maxTotalWaitMs) /
        60_000
    );
    const workflowsDirectory = join(ROOT_DIR, '.github/workflows');
    const declared: string[] = [];
    let callers = 0;
    for (const file of readdirSync(workflowsDirectory).sort()) {
      const steps = extractStepBlocksUsing(
        readFileSync(join(workflowsDirectory, file), 'utf8'),
        './.github/actions/download-run-artifact'
      );
      callers += steps.length;
      for (const step of steps) {
        const minutes = /^ {8}timeout-minutes: (\d+)$/m.exec(step)?.[1];
        if (minutes !== undefined) declared.push(`${file}: ${minutes}`);
        expect(
          Number(minutes ?? worstCaseMinutes),
          `(${file} download-run-artifact step timeout-minutes): expected at least ${worstCaseMinutes} | received: ${minutes}`
        ).toBeGreaterThanOrEqual(worstCaseMinutes);
      }
    }
    // The counts prove the scan found the steps: an empty scan cannot pass.
    expect(callers).toBe(3);
    expect(declared).toEqual(['smoke-binary.yml: 3']);
  });
});

describe('downloadRunArtifact', () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'fix-run-artifact-'));
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  function writeZip(zipPath: string, files: Record<string, string>): string {
    const staging = join(directory, 'zip-staging');
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging);
    for (const [name, text] of Object.entries(files)) writeFileSync(join(staging, name), text);
    rmSync(zipPath, { force: true });
    const { command, cwd } = zipCreationCommand(zipPath, staging);
    const result = Bun.spawnSync([...command], { cwd });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    return `sha256:${createHash('sha256').update(readFileSync(zipPath)).digest('hex')}`;
  }

  // Serves the metadata listing and copies a prepared ZIP for the transfer; the
  // first `stalls` transfers time out the way the Node action did.
  function ghFake(zipPath: string, digest: string, stalls: number) {
    let transfers = 0;
    return fakeRunner((_call, command, stdoutFile) => {
      if (command.includes('--method')) {
        return { stdout: JSON.stringify(listing({ digest, name: 'distribution-x' })) };
      }
      transfers += 1;
      if (transfers <= stalls) return { timedOut: true, exitCode: 1 };
      copyFileSync(zipPath, stdoutFile as string);
      return {};
    });
  }

  test.skipIf(ZIP_UNAVAILABLE)(
    'bundle mode retries a stalled transfer, then keeps only the verified tar',
    async () => {
      const zipPath = join(directory, 'served.zip');
      const digest = writeZip(zipPath, { 'linux-x64.tar': 'bundle bytes' });
      const { run, commands } = ghFake(zipPath, digest, 1);
      const logs: string[] = [];
      const environment = new RecordedRetryEnvironment();
      await downloadRunArtifact({
        repository: 'o/r',
        runId: RUN_ID,
        name: 'distribution-x',
        destination: join(directory, 'out'),
        mode: 'bundle',
        scratchRoot: directory,
        run,
        retry: new GitHubRetry(ARTIFACT_DOWNLOAD_RETRY_POLICY, environment),
        log: (message) => logs.push(message),
      });
      // The retry waits 2 s instead of starting at once.
      expect(environment.waits).toEqual([2_000]);
      expect(readFileSync(join(directory, 'out', 'linux-x64.tar'), 'utf8')).toBe('bundle bytes');
      expect(commands.filter((command) => !command.includes('--method'))).toHaveLength(2);
      expect(logs.join('\n')).toContain('attempt 1/2 failed: Artifact');
    }
  );

  test.skipIf(ZIP_UNAVAILABLE)(
    'refuses a ZIP whose digest differs from the one recorded at upload',
    async () => {
      const zipPath = join(directory, 'served.zip');
      writeZip(zipPath, { 'linux-x64.tar': 'bundle bytes' });
      const { run } = ghFake(zipPath, DIGEST, 0);
      await expect(
        downloadRunArtifact({
          repository: 'o/r',
          runId: RUN_ID,
          name: 'distribution-x',
          destination: join(directory, 'out'),
          mode: 'bundle',
          scratchRoot: directory,
          run,
          log: () => {},
        })
      ).rejects.toThrow(`ZIP digest: expected ${DIGEST} | received sha256:`);
      expect(existsSync(join(directory, 'out', 'linux-x64.tar'))).toBe(false);
    }
  );

  test.skipIf(ZIP_UNAVAILABLE)(
    'tree mode overwrites existing files and leaves no scratch behind',
    async () => {
      const zipPath = join(directory, 'served.zip');
      const digest = writeZip(zipPath, { 'a.txt': 'fresh' });
      const { run } = ghFake(zipPath, digest, 0);
      const destination = join(directory, 'out');
      mkdirSync(destination);
      writeFileSync(join(destination, 'a.txt'), 'stale');
      await downloadRunArtifact({
        repository: 'o/r',
        runId: RUN_ID,
        name: 'distribution-x',
        destination,
        mode: 'tree',
        scratchRoot: directory,
        run,
        log: () => {},
      });
      expect(readFileSync(join(destination, 'a.txt'), 'utf8')).toBe('fresh');
      const leftovers = Array.from(
        new Bun.Glob('run-artifact-*').scanSync({ cwd: directory, onlyFiles: false })
      );
      expect(leftovers, 'scratch directories left under the scratch root').toEqual([]);
    }
  );

  test.skipIf(ZIP_UNAVAILABLE)(
    'bundle mode rejects a ZIP that holds anything but one flat tar',
    async () => {
      const zipPath = join(directory, 'served.zip');
      const digest = writeZip(zipPath, { 'a.tar': '1', 'b.tar': '2' });
      const { run } = ghFake(zipPath, digest, 0);
      await expect(
        downloadRunArtifact({
          repository: 'o/r',
          runId: RUN_ID,
          name: 'distribution-x',
          destination: join(directory, 'out'),
          mode: 'bundle',
          scratchRoot: directory,
          run,
          log: () => {},
        })
      ).rejects.toThrow('expected one flat .tar or .tar.gz bundle');
    }
  );
});
