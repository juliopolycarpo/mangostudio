import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendNpmPublishGithubOutputs,
  classifyPublishFailure,
  formatNpmPublishSummary,
  isMissingPackageViewResult,
  isNpmPublishOidcAvailable,
  isNpmPublishTokenPresent,
  type NpmCommandOptions,
  type NpmCommandResult,
  type NpmPublishLogger,
  type NpmPublishPackage,
  type NpmRunner,
  orderNpmPackageDirs,
  type ProvenancePolicy,
  parseProvenancePolicy,
  publishPackages,
  resolveNpmPublishAuth,
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
    readonly allowLegacyToken?: boolean;
    readonly authMode?: 'legacy-explicit' | 'oidc';
    readonly dryRun?: boolean;
    readonly provenancePolicy?: ProvenancePolicy;
    readonly retryDelaysMs?: readonly number[];
  } = {}
) => {
  const sleeper = new FakeSleeper();
  const logger = new CapturingLogger();
  const result = publishPackages(packages, {
    allowLegacyToken: options.allowLegacyToken,
    authMode: options.authMode ?? 'legacy-explicit',
    dryRun: options.dryRun,
    logger,
    retryDelaysMs: options.retryDelaysMs ?? [10],
    runner,
    sleep: sleeper.sleep,
    provenancePolicy: options.provenancePolicy,
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

describe('parseProvenancePolicy', () => {
  test('accepts required, optional, and disabled', () => {
    expect(parseProvenancePolicy('required')).toBe('required');
    expect(parseProvenancePolicy('optional')).toBe('optional');
    expect(parseProvenancePolicy('disabled')).toBe('disabled');
  });

  test('rejects unknown policies', () => {
    expect(() => parseProvenancePolicy('maybe')).toThrow(/Invalid provenance policy/);
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

describe('resolveNpmPublishAuth', () => {
  test('prefers OIDC when available and legacy is not explicitly used', () => {
    expect(
      resolveNpmPublishAuth({
        allowLegacy: false,
        oidcAvailable: true,
        tokenPresent: false,
      })
    ).toBe('oidc');
    expect(
      resolveNpmPublishAuth({
        allowLegacy: false,
        oidcAvailable: true,
        tokenPresent: true,
      })
    ).toBe('oidc');
  });

  test('uses legacy-explicit only when legacy is allowed and a token is present', () => {
    expect(
      resolveNpmPublishAuth({
        allowLegacy: true,
        oidcAvailable: true,
        tokenPresent: true,
      })
    ).toBe('legacy-explicit');
  });

  test('falls back to OIDC when legacy is allowed but no token is present', () => {
    expect(
      resolveNpmPublishAuth({
        allowLegacy: true,
        oidcAvailable: true,
        tokenPresent: false,
      })
    ).toBe('oidc');
  });

  test('fails closed when neither OIDC nor an allowed legacy token is available', () => {
    expect(() =>
      resolveNpmPublishAuth({
        allowLegacy: false,
        oidcAvailable: false,
        tokenPresent: false,
      })
    ).toThrow(/authentication failed/);
    expect(() =>
      resolveNpmPublishAuth({
        allowLegacy: true,
        oidcAvailable: false,
        tokenPresent: false,
      })
    ).toThrow(/authentication failed/);
    expect(() =>
      resolveNpmPublishAuth({
        allowLegacy: false,
        oidcAvailable: false,
        tokenPresent: true,
      })
    ).toThrow(/authentication failed/);
  });
});

describe('npm publish OIDC detection', () => {
  test('detects GitHub Actions OIDC request env', () => {
    expect(
      isNpmPublishOidcAvailable({
        ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example/actions/id-token',
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'secret',
      })
    ).toBe(true);
    expect(isNpmPublishOidcAvailable({})).toBe(false);
  });

  test('detects a non-empty NODE_AUTH_TOKEN', () => {
    expect(isNpmPublishTokenPresent({ NODE_AUTH_TOKEN: 'tok' })).toBe(true);
    expect(isNpmPublishTokenPresent({ NODE_AUTH_TOKEN: '' })).toBe(false);
    expect(isNpmPublishTokenPresent({})).toBe(false);
  });
});

describe('publishPackages auth reporting', () => {
  test('reports auth=oidc when OIDC env is present', async () => {
    const runner = new FakeNpmRunner([missing(), ok()]);
    const priorUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
    const priorToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    process.env.ACTIONS_ID_TOKEN_REQUEST_URL = 'https://example/actions/id-token';
    process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = 'secret';
    try {
      await expect(
        publishPackages([PLATFORM_PACKAGE], {
          logger: new CapturingLogger(),
          retryDelaysMs: [10],
          runner,
          sleep: () => Promise.resolve(),
        })
      ).resolves.toMatchObject({ auth: 'oidc', published: 1 });
    } finally {
      if (priorUrl === undefined) delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
      else process.env.ACTIONS_ID_TOKEN_REQUEST_URL = priorUrl;
      if (priorToken === undefined) delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
      else process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = priorToken;
    }
  });

  test('fails closed when publishPackages runs without OIDC or allowed legacy token', async () => {
    const runner = new FakeNpmRunner([missing(), ok()]);
    const priorUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
    const priorToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    const priorNpm = process.env.NODE_AUTH_TOKEN;
    delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
    delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    delete process.env.NODE_AUTH_TOKEN;
    try {
      await expect(
        publishPackages([PLATFORM_PACKAGE], {
          allowLegacyToken: false,
          logger: new CapturingLogger(),
          retryDelaysMs: [10],
          runner,
          sleep: () => Promise.resolve(),
        })
      ).rejects.toThrow(/authentication failed/);
      expect(runner.calls).toHaveLength(0);
    } finally {
      if (priorUrl === undefined) delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
      else process.env.ACTIONS_ID_TOKEN_REQUEST_URL = priorUrl;
      if (priorToken === undefined) delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
      else process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = priorToken;
      if (priorNpm === undefined) delete process.env.NODE_AUTH_TOKEN;
      else process.env.NODE_AUTH_TOKEN = priorNpm;
    }
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
      auth: 'not-published',
      provenance: { status: 'explicit' },
    });
    expect(runner.calls.map((call) => call.args[0])).toEqual(['view']);
  });

  test('publishes missing packages with provenance by default (required)', async () => {
    const runner = new FakeNpmRunner([missing(), ok()]);
    const { result } = publishWithFakes(runner);

    await expect(result).resolves.toEqual({
      published: 1,
      skipped: 0,
      dryRun: 0,
      auth: 'legacy-explicit',
      provenance: { status: 'explicit' },
    });
    expect(runner.calls[1].args).toEqual(['publish', '--access', 'public', '--provenance']);
  });

  test('publishes under a dist-tag when one is provided', async () => {
    const runner = new FakeNpmRunner([missing(), ok()]);
    const sleeper = new FakeSleeper();
    await publishPackages([PLATFORM_PACKAGE], {
      authMode: 'legacy-explicit',
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
      auth: 'legacy-explicit',
      provenance: { status: 'explicit' },
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
      auth: 'legacy-explicit',
      provenance: { status: 'explicit' },
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
      auth: 'legacy-explicit',
      provenance: { status: 'explicit' },
    });
    expect(runner.calls.map((call) => call.args[0])).toEqual(['view', 'publish', 'view']);
    expect(sleeper.delays).toEqual([]);
  });

  test('required policy never retries without provenance', async () => {
    const runner = new FakeNpmRunner([
      missing(),
      fail('npm ERR! provenance is not supported for this run'),
    ]);
    const { result } = publishWithFakes(runner, [PLATFORM_PACKAGE], {
      provenancePolicy: 'required',
    });

    await expect(result).rejects.toThrow(/npm publish failed/);
    expect(runner.calls.map((call) => call.args)).toEqual([
      ['view', '@mangostudio/cli-linux-x64@1.2.3', 'version'],
      ['publish', '--access', 'public', '--provenance'],
    ]);
  });

  test('optional policy falls back to non-provenance publish when npm rejects provenance', async () => {
    const runner = new FakeNpmRunner([
      missing(),
      fail('npm ERR! provenance is not supported for this run'),
      ok(),
      missing(),
      ok(),
    ]);
    const { result } = publishWithFakes(runner, [PLATFORM_PACKAGE, CLI_PACKAGE], {
      provenancePolicy: 'optional',
    });

    await expect(result).resolves.toEqual({
      published: 2,
      skipped: 0,
      dryRun: 0,
      auth: 'legacy-explicit',
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
    const { result } = publishWithFakes(runner, [PLATFORM_PACKAGE], {
      provenancePolicy: 'disabled',
    });

    await expect(result).resolves.toEqual({
      published: 1,
      skipped: 0,
      dryRun: 0,
      auth: 'legacy-explicit',
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
        auth: 'legacy-explicit',
        provenance: { status: 'dropped', package: '@mangostudio/cli-linux-x64@1.2.3' },
      })
    ).toBe(
      'npm publish complete: 2 published, 1 skipped, 0 dry-run. Auth: legacy-explicit. Provenance: dropped at @mangostudio/cli-linux-x64@1.2.3.'
    );
  });

  test('dry-run prints the pending publish without publishing', async () => {
    const runner = new FakeNpmRunner([missing()]);
    const { logger, result } = publishWithFakes(runner, [PLATFORM_PACKAGE], { dryRun: true });

    await expect(result).resolves.toEqual({
      published: 0,
      skipped: 0,
      dryRun: 1,
      auth: 'legacy-explicit',
      provenance: { status: 'explicit' },
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

  test('writes auth and provenance to GITHUB_OUTPUT', () => {
    const dir = mkdtempSync(join(tmpdir(), 'npm-publish-out-'));
    const outputPath = join(dir, 'github_output');
    try {
      appendNpmPublishGithubOutputs(
        {
          published: 1,
          skipped: 0,
          dryRun: 0,
          auth: 'oidc',
          provenance: { status: 'explicit' },
        },
        outputPath
      );
      expect(readFileSync(outputPath, 'utf8')).toBe('auth=oidc\nprovenance=explicit\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
