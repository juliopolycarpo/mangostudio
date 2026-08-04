import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { DEFAULT_SSH_RUNTIME_PATH, type RuntimeSetupBody } from '@mangostudio/shared/environments';
import { RUNTIME_CAPABILITY_KEYS, RUNTIME_CONSENT_PRESETS } from '@mangostudio/shared/runtime-home';
import {
  buildSetupCommand,
  pushRuntimeOverSsh,
} from '../../../../src/modules/environments/application/runtime-lifecycle-service';
import type {
  RuntimeCommandOptions,
  RuntimeCommandResult,
} from '../../../../src/modules/environments/domain/runtime-push';

function ok(stdout = ''): RuntimeCommandResult {
  return { stdout, stderr: '', exitCode: 0 };
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
  // (apps/runtime/src/setup.ts), and `--profile custom` is rejected outright
  // (apps/runtime/src/cli.ts) — the custom branch used to omit --profile
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
      return Promise.resolve(script.includes('--version') ? ok('0.0.1-old') : ok('BeOS\nz80\n'));
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
});
