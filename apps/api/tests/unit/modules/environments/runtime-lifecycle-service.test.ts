import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { join } from 'node:path';

import { RemoteError } from '@mangostudio/protocol';
import { DEFAULT_SSH_RUNTIME_PATH, type RuntimeSetupBody } from '@mangostudio/shared/environments';
import { RUNTIME_UPDATE_REFUSED } from '@mangostudio/shared/runtime-contract';
import { RUNTIME_CAPABILITY_KEYS, RUNTIME_CONSENT_PRESETS } from '@mangostudio/shared/runtime-home';

import { EnvironmentUnavailableError } from '../../../../src/lib/environment-unavailable';
import {
  buildSetupCommand,
  failureLineFor,
  pushRuntimeOverSsh,
  restartBudgetMs,
  RuntimeLifecycleConflictError,
  RuntimeLifecycleUnavailableError,
} from '../../../../src/modules/environments/application/runtime-lifecycle-service';
import {
  type RuntimeCommandOptions,
  type RuntimeCommandResult,
  RuntimePushError,
} from '../../../../src/modules/environments/domain/runtime-push';
import { RuntimeAssetLoadError } from '../../../../src/modules/environments/domain/runtime-release-fetch';
import {
  WslDevBuildError,
  WslProvisioningError,
} from '../../../../src/modules/environments/infrastructure/wsl-provisioner';
import { DiagnosticWarnCapture, expectHubLogEntry } from '../../../support/diagnostic-warn-capture';

function ok(stdout = ''): RuntimeCommandResult {
  return { stdout, stderr: '', exitCode: 0 };
}

/**
 * Which of the two scripts a push runs this is.
 *
 * Not `--version`: the platform probe's own last line is `ldd --version`, and a
 * runner that discriminated on that substring answered the probe with the
 * version check's reply.
 */
function isPlatformProbe(script: string): boolean {
  return script.startsWith('uname -s');
}

describe('buildSetupCommand', () => {
  it('sends a preset profile through --profile with no --allow', () => {
    const body: RuntimeSetupBody = { profile: 'readonly' };
    const command = buildSetupCommand(body, RUNTIME_CONSENT_PRESETS.readonly);

    expect(command.script).toContain('setup --slot remote --profile "$2" --yes --json');
    expect(command.script).not.toContain('--allow');
    expect(command.args).toEqual([DEFAULT_SSH_RUNTIME_PATH, 'readonly']);
  });

  // Regression: the binary path used to be a hardcoded managed-slot constant,
  // so the one action a custom-`remoteRuntimePath` card still offers ran a
  // binary that environment does not use — and need not have.
  it('runs the environment its own runtime path when one is configured', () => {
    const command = buildSetupCommand(
      { profile: 'full' },
      RUNTIME_CONSENT_PRESETS.full,
      '/opt/mango/bin/mangostudio-runtime'
    );

    expect(command.args[0]).toBe('/opt/mango/bin/mangostudio-runtime');
    // The path travels as argv; the script itself stays a constant.
    expect(command.script).not.toContain('/opt/mango');
    expect(command.script).toContain('exec "$p"');
    // Consent is still recorded in the slot the SSH transport reads.
    expect(command.script).toContain('--slot remote');
  });

  it('leaves a path with shell metacharacters as one literal argv entry', () => {
    const hostile = '/tmp/x; touch /tmp/pwned';
    const command = buildSetupCommand({ profile: 'none' }, RUNTIME_CONSENT_PRESETS.none, hostile);

    expect(command.args[0]).toBe(hostile);
    expect(command.script).not.toContain('touch');
  });

  // Regression: the CLI's `setup --yes` refuses to run without a --profile
  // and `--profile custom` is rejected outright
  // (crates/mangostudio-runtime/src/cli.rs) — the custom branch used to omit --profile
  // entirely, so every custom consent submission failed on a fresh remote.
  it('sends custom profiles through --profile none plus an explicit --allow set', () => {
    const allow = { ...RUNTIME_CONSENT_PRESETS.none, shell: true, fsWrite: false };
    const body: RuntimeSetupBody = { profile: 'custom', allow };
    const command = buildSetupCommand(body, allow);

    expect(command.script).toContain('--profile none --allow "$2" --yes --json');
    expect(command.args).toHaveLength(2);
    const parsed = Object.fromEntries(
      (command.args[1] ?? '').split(',').map((entry) => {
        const [key, value] = entry.split('=');
        return [key, value === 'true'];
      })
    );
    for (const key of RUNTIME_CAPABILITY_KEYS) {
      expect(parsed[key]).toBe(allow[key]);
    }
  });
});

describe('pushRuntimeOverSsh', () => {
  const originalVersion = process.env.VERSION;

  beforeEach(() => {
    // Version equality is the fast path's whole premise; it needs a version a
    // release could have cut, not the "dev" a source checkout reports.
    process.env.VERSION = '9.9.9-test';
  });

  afterEach(() => {
    if (originalVersion === undefined) delete process.env.VERSION;
    else process.env.VERSION = originalVersion;
  });

  // Regression: pushOverSsh used to re-download and re-transfer on every
  // install click regardless of what was already there, because nothing
  // checked the remote's reported version first.
  it('makes exactly one call — the version check — when the remote already matches', async () => {
    const calls: string[] = [];
    const runner = (
      script: string,
      _options?: RuntimeCommandOptions
    ): Promise<RuntimeCommandResult> => {
      calls.push(script);
      return Promise.resolve(ok('9.9.9-test'));
    };

    const logs: string[] = [];
    const stream = {
      events: [],
      closed: false,
      publish: (event: { type: string; line?: string }) => {
        if (event.type === 'log' && event.line) logs.push(event.line);
      },
      close: () => undefined,
      subscribe: () => {
        throw new Error('not used in this test');
      },
    };

    await pushRuntimeOverSsh(
      runner,
      'example.test',
      stream as unknown as Parameters<typeof pushRuntimeOverSsh>[2],
      new AbortController().signal
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('--version');
    expect(logs.some((line) => line.includes('nothing to push'))).toBe(true);
  });

  it('probes the platform when the remote reports a different version', async () => {
    const calls: string[] = [];
    const runner = (
      script: string,
      _options?: RuntimeCommandOptions
    ): Promise<RuntimeCommandResult> => {
      calls.push(script);
      // An unresolvable platform probe fails fast and deterministically right
      // after the probe, with no network call — the test only cares that the
      // version mismatch let the flow reach the probe at all.
      //
      // Matched on `uname`, not on `--version`: the probe script runs
      // `ldd --version` itself, so the looser test answered the probe with the
      // version string and never reached this fixture at all.
      return Promise.resolve(isPlatformProbe(script) ? ok('BeOS\nz80\n') : ok('0.0.1-old'));
    };

    const stream = {
      events: [],
      closed: false,
      publish: () => undefined,
      close: () => undefined,
      subscribe: () => {
        throw new Error('not used in this test');
      },
    };

    await expect(
      pushRuntimeOverSsh(
        runner,
        'example.test',
        stream as unknown as Parameters<typeof pushRuntimeOverSsh>[2],
        new AbortController().signal
      )
    ).rejects.toThrow();

    expect(calls.length).toBeGreaterThan(1);
    expect(calls[0]).toContain('--version');
  });

  /** A runner that answers the version check as stale and the probe with `stdout`. */
  function runnerProbing(stdout: string) {
    return (script: string, _options?: RuntimeCommandOptions): Promise<RuntimeCommandResult> =>
      Promise.resolve(isPlatformProbe(script) ? ok(stdout) : ok('0.0.1-old'));
  }

  const silentStream = {
    events: [],
    closed: false,
    publish: () => undefined,
    close: () => undefined,
    subscribe: () => {
      throw new Error('not used in this test');
    },
  };

  function push(runner: ReturnType<typeof runnerProbing>): Promise<void> {
    return pushRuntimeOverSsh(
      runner,
      'example.test',
      silentStream as unknown as Parameters<typeof pushRuntimeOverSsh>[2],
      new AbortController().signal
    );
  }

  // Regression: a host whose `ldd` prints nothing answers the probe in two
  // lines, and this call site used to read those as machine-and-libc with the
  // kernel assumed — so `uname -s` became the machine and the refusal named a
  // platform the host never reported.
  it('reads a two-line probe the way every other transport does', async () => {
    await expect(push(runnerProbing('Linux\nz80\n'))).rejects.toThrow('(Linux z80)');
  });

  it('quotes an unreadable probe instead of guessing a platform from it', async () => {
    await expect(push(runnerProbing('Linux\n'))).rejects.toThrow(
      'Could not read what "example.test" reported about itself: Linux'
    );
  });

  it('hands a failed platform probe to the run line as command output, not message text', async () => {
    const runner = (script: string): Promise<RuntimeCommandResult> =>
      Promise.resolve(
        isPlatformProbe(script)
          ? { stdout: '', stderr: 'Permission denied (publickey).', exitCode: 255 }
          : ok('0.0.1-old')
      );

    const failure: unknown = await push(runner).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RuntimePushError);
    expect((failure as RuntimePushError).remote).toEqual({
      exitCode: 255,
      output: 'Permission denied (publickey).',
    });
  });
});

describe('failureLineFor', () => {
  const HUB_PATH = '/home/alice/.mango/runtime/cache/linux-x64.tmp';
  const WSL_PATH = 'C:\\Users\\alice\\AppData\\Local\\wsl.exe';
  // `--out` is relative to the repository root, so the line carries no hub path.
  const DEV_BUILD_LINE = `This MangoStudio runs from a source checkout and needs its own Linux runtime in the WSL distribution. From the repository root run \`bun run build:runtime --platform linux-x64 --dev --zig --rustup --out ${join('.mango', 'out')}\`, then connect again. Details are in the hub log.`;

  // Regression: any thrown error's text reached the run's stderr stream.
  it('replaces the text of an error the hub did not word for the user', () => {
    const line = failureLineFor(
      new Error(`EACCES: permission denied, open '${HUB_PATH}'`),
      'r1',
      'e1'
    );

    expect(line).toBe('The runtime action failed. Details are in the hub log.');
    expect(line).not.toContain(HUB_PATH);
  });

  it('gives a connect refusal its fixed per-reason copy, not the manager text', () => {
    const line = failureLineFor(
      new EnvironmentUnavailableError('binary-missing', `searched ${HUB_PATH}`),
      'r1',
      'e1'
    );

    expect(line).toBe('The runtime for this environment is not installed on the hub.');
  });

  it('passes through a lifecycle refusal, whose text this module writes', () => {
    expect(
      failureLineFor(new RuntimeLifecycleUnavailableError('Pick a runtime first.', 409), 'r1', 'e1')
    ).toBe('Pick a runtime first.');
    expect(failureLineFor(new RuntimeLifecycleConflictError('A run is active.'), 'r1', 'e1')).toBe(
      'A run is active.'
    );
  });

  // Regression (#2340): provisioning, push, release-fetch and runtime-sent text
  // used to be the stderr line. Each embeds a path, remote stderr or driver
  // wording, so each now gets fixed copy and the hub log gets the error.
  const RAW_DETAIL_CASES: readonly (readonly [
    label: string,
    error: Error,
    reason: string,
    fragment: string,
    line: string,
  ])[] = [
    [
      'a WSL provisioning failure',
      new WslProvisioningError(`Could not run WSL at "${WSL_PATH}": spawn EACCES`),
      'wsl-provisioning-failed',
      WSL_PATH,
      'The runtime could not be set up in the WSL distribution. Check that the distribution starts, then try again. Details are in the hub log.',
    ],
    // Regression: this hint was lost when every WslProvisioningError became the
    // generic sentence. The line names the build, never the hub's own path.
    [
      'a checkout whose WSL runtime reports the wrong version',
      new WslDevBuildError(
        `The runtime installed in "Ubuntu" reports version 0.1.1 rather than dev. build one with \`bun run build:runtime --out ${HUB_PATH}\`.`,
        'linux-x64'
      ),
      'wsl-dev-build-required',
      HUB_PATH,
      DEV_BUILD_LINE,
    ],
    [
      'a checkout with no local WSL runtime build',
      new WslDevBuildError(`No runtime at ${HUB_PATH}; build one.`, 'linux-x64'),
      'wsl-dev-build-required',
      HUB_PATH,
      DEV_BUILD_LINE,
    ],
    [
      'a push error without a command result',
      new RuntimePushError(`Could not read what "h" reported about itself: ${HUB_PATH}`),
      'runtime-push-failed',
      HUB_PATH,
      'The runtime could not be copied to the machine. Check the machine, then try again. Details are in the hub log.',
    ],
    [
      'a push error from an SSH command that was refused',
      new RuntimePushError(`Could not probe "h": Permission denied (publickey) for ${HUB_PATH}`, {
        remote: { exitCode: 255, output: `Permission denied (publickey) for ${HUB_PATH}` },
      }),
      'auth-failed',
      HUB_PATH,
      'The machine rejected the SSH credentials. Check the user name and identity file on the environment, then try again. Details are in the hub log.',
    ],
    [
      'a push error from a command with no known cause',
      new RuntimePushError(`Could not place the runtime in the remote slot: ${HUB_PATH}`, {
        remote: { exitCode: 2, output: HUB_PATH },
      }),
      'remote-command-failed',
      HUB_PATH,
      'The command on the machine failed (exit code 2). Check the machine, then try again. Details are in the hub log.',
    ],
    [
      'an unreachable release host',
      new RuntimeAssetLoadError(`Could not download https://x.test/a: connect ECONNREFUSED`, {
        unreachable: true,
      }),
      'release-unreachable',
      'ECONNREFUSED',
      "The hub could not reach the release host to download the runtime. Check the hub's network, then try again. Details are in the hub log.",
    ],
    [
      'a release that answered but could not be used',
      new RuntimeAssetLoadError(`No local runtime build at ${HUB_PATH} for version "dev".`),
      'release-unavailable',
      HUB_PATH,
      'The runtime for this release could not be loaded or verified. Details are in the hub log.',
    ],
    [
      'a reserved runtime error code',
      new RemoteError('DENIED', `fsRead was not granted for ${HUB_PATH}`),
      'runtime-error',
      HUB_PATH,
      'The runtime reported an error (DENIED). Details are in the hub log.',
    ],
    [
      'a runtime error with a code the runtime chose',
      new RemoteError('CODE_FROM_THE_PEER', `boom at ${HUB_PATH}`),
      'runtime-error',
      'CODE_FROM_THE_PEER',
      'The runtime reported an error. Details are in the hub log.',
    ],
  ];

  for (const [label, error, reason, fragment, expectedLine] of RAW_DETAIL_CASES) {
    it(`gives ${label} fixed copy and logs the raw text with the run and environment`, async () => {
      let line = '';
      const logged = await new DiagnosticWarnCapture().during(() => {
        line = failureLineFor(error, 'run-9', 'env-9');
      });

      expect(line).toBe(expectedLine);
      expect(
        line.includes(fragment),
        `(${label}): expected a line without "${fragment}" | received: ${line}`
      ).toBe(false);
      expectHubLogEntry(logged, 'run_failed', {
        fields: { runId: 'run-9', environmentId: 'env-9', reason },
        fragment,
      });
    });
  }

  it('keeps the update-refused code, which the runtime defines, in the line', () => {
    expect(
      failureLineFor(new RemoteError(RUNTIME_UPDATE_REFUSED, 'digest mismatch'), 'r1', 'e1')
    ).toBe('The runtime reported an error (RUNTIME_UPDATE_REFUSED). Details are in the hub log.');
  });
});

describe('restartBudgetMs', () => {
  // Regression: the post-commit wait was one minute on every platform, which is
  // exactly the `-RestartInterval 1 minute` a supervised Windows peer sits out
  // before Task Scheduler even tries the new bytes. Every win32 live upgrade
  // committed and then reported failed.
  it('gives a Windows peer more than the Task Scheduler restart interval', () => {
    expect(restartBudgetMs('win32')).toBeGreaterThan(60_000);
  });

  it('leaves every other platform on the one-minute budget', () => {
    expect(restartBudgetMs('linux')).toBe(60_000);
    expect(restartBudgetMs('darwin')).toBe(60_000);
    expect(restartBudgetMs(undefined)).toBe(60_000);
  });
});
