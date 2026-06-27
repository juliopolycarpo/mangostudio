import { describe, expect, test } from 'bun:test';
import {
  classifyPublishFailure,
  formatNpmPublishSummary,
  isMissingPackageViewResult,
  type NpmCommandOptions,
  type NpmCommandResult,
  type NpmPublishLogger,
  type NpmPublishPackage,
  type NpmRunner,
  orderNpmPackageDirs,
  publishPackages,
} from '../lib/npm-publish';

const PLATFORM_PACKAGE: NpmPublishPackage = {
  dir: '/dist/linux-x64',
  name: '@mangostudio/cli-linux-x64',
  version: '1.2.3',
};

const CLI_PACKAGE: NpmPublishPackage = {
  dir: '/dist/cli',
  name: 'mangostudio',
  version: '1.2.3',
};

interface NpmCall {
  readonly args: readonly string[];
  readonly cwd: string;
}

class FakeNpmRunner implements NpmRunner {
  readonly calls: NpmCall[] = [];

  constructor(private readonly responses: NpmCommandResult[]) {}

  run(args: readonly string[], options: NpmCommandOptions): Promise<NpmCommandResult> {
    this.calls.push({ args: [...args], cwd: options.cwd });
    const response = this.responses.shift();
    if (!response) throw new Error(`Unexpected npm call: ${args.join(' ')}`);
    return Promise.resolve(response);
  }
}

class FakeSleeper {
  readonly delays: number[] = [];

  sleep = (ms: number): Promise<void> => {
    this.delays.push(ms);
    return Promise.resolve();
  };
}

class CapturingLogger implements NpmPublishLogger {
  readonly messages: string[] = [];

  info(message: string): void {
    this.messages.push(message);
  }

  warn(message: string): void {
    this.messages.push(message);
  }
}

const ok = (stdout = ''): NpmCommandResult => ({ exitCode: 0, stdout, stderr: '' });
const fail = (stderr: string): NpmCommandResult => ({ exitCode: 1, stdout: '', stderr });
const missing = (): NpmCommandResult => fail('npm ERR! code E404\n404 Not Found');

const publishWithFakes = (
  runner: FakeNpmRunner,
  packages: readonly NpmPublishPackage[] = [PLATFORM_PACKAGE],
  options: {
    readonly dryRun?: boolean;
    readonly provenance?: boolean;
    readonly retryDelaysMs?: readonly number[];
  } = {}
) => {
  const sleeper = new FakeSleeper();
  const logger = new CapturingLogger();
  const result = publishPackages(packages, {
    dryRun: options.dryRun,
    logger,
    retryDelaysMs: options.retryDelaysMs ?? [10],
    runner,
    sleep: sleeper.sleep,
    provenance: options.provenance,
  });

  return { logger, result, sleeper };
};

describe('orderNpmPackageDirs', () => {
  test('keeps known platforms first and the wrapper last', () => {
    expect(orderNpmPackageDirs(['cli', 'windows-x64', 'linux-x64', 'darwin-arm64'])).toEqual([
      'linux-x64',
      'darwin-arm64',
      'windows-x64',
      'cli',
    ]);
  });
});

describe('npm publish failure classification', () => {
  test('detects missing package responses from npm view', () => {
    expect(isMissingPackageViewResult(missing())).toBe(true);
    expect(
      isMissingPackageViewResult(
        fail('error: No version of "mangostudio" satisfying "1.2.3" found')
      )
    ).toBe(true);
  });

  test('classifies publish failures by retry behavior', () => {
    expect(classifyPublishFailure(fail('npm ERR! code E403 previously published'))).toBe(
      'conflict'
    );
    expect(classifyPublishFailure(fail('npm ERR! provenance attestation failed'))).toBe(
      'provenance'
    );
    expect(classifyPublishFailure(fail('npm ERR! code ECONNRESET socket hang up'))).toBe(
      'transient'
    );
    expect(classifyPublishFailure(fail('npm ERR! bad package'))).toBe('fatal');
  });
});

describe('publishPackages', () => {
  test('skips versions that already exist', async () => {
    const runner = new FakeNpmRunner([ok('1.2.3\n')]);
    const { result } = publishWithFakes(runner);

    await expect(result).resolves.toEqual({
      published: 0,
      skipped: 1,
      dryRun: 0,
      provenance: { status: 'full' },
    });
    expect(runner.calls.map((call) => call.args[0])).toEqual(['view']);
  });

  test('publishes missing packages with provenance by default', async () => {
    const runner = new FakeNpmRunner([missing(), ok()]);
    const { result } = publishWithFakes(runner);

    await expect(result).resolves.toEqual({
      published: 1,
      skipped: 0,
      dryRun: 0,
      provenance: { status: 'full' },
    });
    expect(runner.calls[1].args).toEqual(['publish', '--access', 'public', '--provenance']);
  });

  test('publishes under a dist-tag when one is provided', async () => {
    const runner = new FakeNpmRunner([missing(), ok()]);
    const sleeper = new FakeSleeper();
    await publishPackages([PLATFORM_PACKAGE], {
      distTag: 'canary',
      logger: new CapturingLogger(),
      retryDelaysMs: [10],
      runner,
      sleep: sleeper.sleep,
    });

    // --tag precedes --provenance, and the default path (no distTag) stays bare.
    expect(runner.calls[1].args).toEqual([
      'publish',
      '--access',
      'public',
      '--tag',
      'canary',
      '--provenance',
    ]);
  });

  test('omits scoped access flags for the unscoped wrapper', async () => {
    const runner = new FakeNpmRunner([missing(), ok()]);
    const { result } = publishWithFakes(runner, [CLI_PACKAGE]);

    await expect(result).resolves.toEqual({
      published: 1,
      skipped: 0,
      dryRun: 0,
      provenance: { status: 'full' },
    });
    expect(runner.calls[1].args).toEqual(['publish', '--provenance']);
  });

  test('retries transient publish failures before succeeding', async () => {
    const runner = new FakeNpmRunner([missing(), fail('ECONNRESET socket hang up'), ok()]);
    const { result, sleeper } = publishWithFakes(runner);

    await expect(result).resolves.toEqual({
      published: 1,
      skipped: 0,
      dryRun: 0,
      provenance: { status: 'full' },
    });
    expect(runner.calls.map((call) => call.args[0])).toEqual(['view', 'publish', 'publish']);
    expect(sleeper.delays).toEqual([10]);
  });

  test('re-checks npm view after a version conflict', async () => {
    const runner = new FakeNpmRunner([
      missing(),
      fail('npm ERR! code E403 previously published'),
      ok('1.2.3\n'),
    ]);
    const { result, sleeper } = publishWithFakes(runner);

    await expect(result).resolves.toEqual({
      published: 1,
      skipped: 0,
      dryRun: 0,
      provenance: { status: 'full' },
    });
    expect(runner.calls.map((call) => call.args[0])).toEqual(['view', 'publish', 'view']);
    expect(sleeper.delays).toEqual([]);
  });

  test('falls back to non-provenance publish when npm rejects provenance', async () => {
    const runner = new FakeNpmRunner([
      missing(),
      fail('npm ERR! provenance is not supported for this run'),
      ok(),
      missing(),
      ok(),
    ]);
    const { result } = publishWithFakes(runner, [PLATFORM_PACKAGE, CLI_PACKAGE]);

    await expect(result).resolves.toEqual({
      published: 2,
      skipped: 0,
      dryRun: 0,
      provenance: {
        status: 'dropped',
        package: '@mangostudio/cli-linux-x64@1.2.3',
      },
    });
    expect(runner.calls[1].args).toEqual(['publish', '--access', 'public', '--provenance']);
    expect(runner.calls[2].args).toEqual(['publish', '--access', 'public']);
    expect(runner.calls[4].args).toEqual(['publish']);
  });

  test('summarizes disabled provenance without passing the flag', async () => {
    const runner = new FakeNpmRunner([missing(), ok()]);
    const { result } = publishWithFakes(runner, [PLATFORM_PACKAGE], { provenance: false });

    await expect(result).resolves.toEqual({
      published: 1,
      skipped: 0,
      dryRun: 0,
      provenance: { status: 'disabled' },
    });
    expect(runner.calls[1].args).toEqual(['publish', '--access', 'public']);
  });

  test('formats the provenance outcome for the CLI summary', () => {
    expect(
      formatNpmPublishSummary({
        published: 2,
        skipped: 1,
        dryRun: 0,
        provenance: { status: 'dropped', package: '@mangostudio/cli-linux-x64@1.2.3' },
      })
    ).toBe(
      'npm publish complete: 2 published, 1 skipped, 0 dry-run. Provenance: dropped at @mangostudio/cli-linux-x64@1.2.3.'
    );
  });

  test('dry-run prints the pending publish without publishing', async () => {
    const runner = new FakeNpmRunner([missing()]);
    const { logger, result } = publishWithFakes(runner, [PLATFORM_PACKAGE], { dryRun: true });

    await expect(result).resolves.toEqual({
      published: 0,
      skipped: 0,
      dryRun: 1,
      provenance: { status: 'full' },
    });
    expect(runner.calls.map((call) => call.args[0])).toEqual(['view']);
    expect(logger.messages.join('\n')).toContain('would publish @mangostudio/cli-linux-x64@1.2.3');
  });

  test('fails when transient publish retries do not make the version visible', async () => {
    const runner = new FakeNpmRunner([missing(), fail('ETIMEDOUT'), fail('ETIMEDOUT'), missing()]);
    const { result, sleeper } = publishWithFakes(runner, [PLATFORM_PACKAGE], {
      retryDelaysMs: [5],
    });

    await expect(result).rejects.toThrow(/remains unpublished/);
    expect(sleeper.delays).toEqual([5]);
  });
});
