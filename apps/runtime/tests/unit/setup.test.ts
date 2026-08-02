import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RUNTIME_CAPABILITY_KEYS,
  RUNTIME_CONSENT_PRESETS,
  SHELL_TRUST_NOTICE,
} from '@mangostudio/shared/runtime-home';
import { collectRuntimeHealth, diagnoseRuntimeHealth, worstSeverity } from '../../src/health';
import { readRuntimeSlotConfig, writeRuntimeSlotConfig } from '../../src/runtime-home';
import { parseAllowOverrides, type RuntimeSetupArgs, runRuntimeSetup } from '../../src/setup';

const homes: string[] = [];
const RUNTIME_VERSION = '9.9.9-test';

afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

async function isolatedEnv(
  extra: Readonly<Record<string, string>> = {}
): Promise<NodeJS.ProcessEnv> {
  const home = await mkdtemp(join(tmpdir(), 'mango-runtime-setup-'));
  homes.push(home);
  return { MANGO_HOME: home, ...extra };
}

interface SetupRun {
  readonly code: number;
  readonly lines: string[];
  readonly env: NodeJS.ProcessEnv;
}

async function setup(
  args: Partial<RuntimeSetupArgs> = {},
  options: { readonly env?: NodeJS.ProcessEnv; readonly answers?: readonly string[] } = {}
): Promise<SetupRun> {
  const env = options.env ?? (await isolatedEnv());
  const lines: string[] = [];
  const answers = [...(options.answers ?? [])];
  const code = await runRuntimeSetup(
    { yes: false, json: false, ...args },
    {
      runtimeVersion: RUNTIME_VERSION,
      env,
      write: (line) => lines.push(line),
      ...(options.answers ? { ask: async () => answers.shift() ?? '' } : {}),
    }
  );
  return { code, lines, env };
}

describe('parseAllowOverrides', () => {
  it('parses a comma-separated override list', () => {
    expect(parseAllowOverrides('shell=false,fsWrite=true')).toEqual({
      allow: { shell: false, fsWrite: true },
    });
  });

  it('accepts the spellings a person types', () => {
    expect(parseAllowOverrides('shell=no,git=on')).toEqual({ allow: { shell: false, git: true } });
  });

  it('names an unknown capability rather than ignoring it', () => {
    const parsed = parseAllowOverrides('telepathy=true');
    expect('error' in parsed && parsed.error).toContain('telepathy');
  });

  it('refuses a value that is not a boolean', () => {
    const parsed = parseAllowOverrides('shell=sometimes');
    expect('error' in parsed && parsed.error).toContain('true or false');
  });

  it('refuses a bare key, which would otherwise read as a grant', () => {
    expect('error' in parseAllowOverrides('shell')).toBe(true);
  });
});

describe('runtime setup', () => {
  it('writes the exact allow set a named profile means', async () => {
    const run = await setup({ profile: 'readonly', yes: true });
    expect(run.code).toBe(0);

    const config = await readRuntimeSlotConfig('host', run.env);
    expect(config.allow).toEqual(RUNTIME_CONSENT_PRESETS.readonly);
    expect(config.profile).toBe('readonly');
    expect(config.setup).toMatchObject({ state: 'configured', by: 'cli' });
    expect(config.version).toBe(RUNTIME_VERSION);
  });

  it('records overrides over a preset as a custom profile', async () => {
    const run = await setup({ profile: 'readonly', allow: { shell: true }, yes: true });

    const config = await readRuntimeSlotConfig('host', run.env);
    expect(config.profile).toBe('custom');
    expect(config.allow.shell).toBe(true);
    expect(config.allow.fsWrite).toBe(false);
  });

  it('accepts the answer an image supplies through the environment', async () => {
    const env = await isolatedEnv({ MANGOSTUDIO_RUNTIME_SETUP: 'full' });
    const run = await setup({ yes: true }, { env });
    expect(run.code).toBe(0);

    const config = await readRuntimeSlotConfig('host', env);
    expect(config.profile).toBe('full');
    expect(config.setup.by).toBe('env');
  });

  it('reports an environment answer it cannot use instead of ignoring it', async () => {
    const env = await isolatedEnv({ MANGOSTUDIO_RUNTIME_SETUP: 'everything' });
    const run = await setup({ yes: true }, { env });

    expect(run.code).toBe(1);
    expect(run.lines.join('\n')).toContain('everything');
    // Nothing was written: a config with no timestamp is the slot default.
    expect((await readRuntimeSlotConfig('host', env)).setup.at).toBeUndefined();
  });

  it('refuses to invent an answer when there is nobody to ask', async () => {
    const run = await setup({ yes: true });

    expect(run.code).toBe(1);
    expect(run.lines.join('\n')).toContain('--profile');
  });

  it('asks, and says the shell sentence before it does', async () => {
    const run = await setup({}, { answers: ['2'] });

    expect(run.code).toBe(0);
    expect(run.lines.join('\n')).toContain(SHELL_TRUST_NOTICE);
    expect((await readRuntimeSlotConfig('host', run.env)).profile).toBe('readonly');
  });

  it('accepts the profile name as well as its number', async () => {
    const run = await setup({}, { answers: ['full', 'n'] });

    const config = await readRuntimeSlotConfig('host', run.env);
    expect(config.allow.shell).toBe(true);
    // Answering the update question narrows an otherwise-full profile.
    expect(config.allow.update).toBe(false);
    expect(config.profile).toBe('custom');
  });

  it('writes nothing when the answer is not a profile', async () => {
    const run = await setup({}, { answers: ['maybe'] });

    expect(run.code).toBe(1);
    const state = await readRuntimeSlotConfig('host', run.env);
    expect(state.setup.at).toBeUndefined();
  });

  it('prints the resulting health payload for a caller that cannot read prose', async () => {
    const run = await setup({ profile: 'full', yes: true, json: true });

    const payload = JSON.parse(run.lines.join('')) as { profile: string; allow: object };
    expect(payload.profile).toBe('full');
    expect(Object.keys(payload.allow).sort()).toEqual([...RUNTIME_CAPABILITY_KEYS].sort());
  });

  it('leaves what an earlier run stored alone', async () => {
    const env = await isolatedEnv();
    await writeRuntimeSlotConfig(
      'host',
      { hubUrl: 'wss://hub.test/api/runtime', digest: `sha256:${'b'.repeat(64)}` },
      env
    );

    await setup({ profile: 'none', yes: true }, { env });

    const config = await readRuntimeSlotConfig('host', env);
    expect(config.hubUrl).toBe('wss://hub.test/api/runtime');
    expect(config.digest).toBe(`sha256:${'b'.repeat(64)}`);
    expect(config.profile).toBe('none');
  });

  it('answers for the slot it runs as and never for another', async () => {
    const { shouldRefuseStdioForPendingSetup } = await import('../../src/cli');
    const env = await isolatedEnv();
    await writeRuntimeSlotConfig('remote', { setup: { state: 'pending' } }, env);
    const remoteBinary = join(env.MANGO_HOME as string, 'runtime', 'remote', 'current', 'x');
    expect(await shouldRefuseStdioForPendingSetup(env, [remoteBinary])).toBe(true);

    await runRuntimeSetup(
      { profile: 'full', yes: true, json: false },
      {
        runtimeVersion: RUNTIME_VERSION,
        env,
        write: () => undefined,
      }
    );

    // The host slot is what this process resolves to, so the remote gate is
    // still closed: setup answers for the slot it runs as, never for another.
    expect(await shouldRefuseStdioForPendingSetup(env, [remoteBinary])).toBe(true);
  });
});

describe('runtime health', () => {
  it('reports the slot, its consent, and where the bytes are', async () => {
    const env = await isolatedEnv();
    await setup({ profile: 'readonly', yes: true }, { env });

    const report = await collectRuntimeHealth({ runtimeVersion: RUNTIME_VERSION, env });
    expect(report.slot).toBe('host');
    expect(report.profile).toBe('readonly');
    expect(report.setup.state).toBe('configured');
    expect(report.runtimeVersion).toBe(RUNTIME_VERSION);
    expect(report.lastError).toBeNull();
    // The test process is Bun running a workspace entry, so there is no binary.
    expect(report.binaryPath).toBeNull();
    expect(report.source).toBe('source-checkout');
  });

  it('fails doctor on a slot nobody has answered for, and names the fix', async () => {
    const env = await isolatedEnv();
    await writeRuntimeSlotConfig('host', { setup: { state: 'pending' } }, env);

    const findings = diagnoseRuntimeHealth(
      await collectRuntimeHealth({ runtimeVersion: RUNTIME_VERSION, env })
    );
    const consent = findings.find((finding) => finding.title === 'Consent');
    expect(consent?.severity).toBe('fail');
    expect(consent?.fix).toBe('mangostudio-runtime setup');
    expect(worstSeverity(findings)).toBe('fail');
  });

  it('says the shell sentence whenever a profile grants one', async () => {
    const env = await isolatedEnv();
    await setup({ profile: 'full', yes: true }, { env });

    const findings = diagnoseRuntimeHealth(
      await collectRuntimeHealth({ runtimeVersion: RUNTIME_VERSION, env })
    );
    expect(findings.find((finding) => finding.title === 'Consent')?.detail).toContain(
      SHELL_TRUST_NOTICE
    );
  });

  it('warns when the recorded install no longer matches the running binary', async () => {
    const env = await isolatedEnv();
    await writeRuntimeSlotConfig('host', { version: '0.0.1', setup: { state: 'configured' } }, env);

    const findings = diagnoseRuntimeHealth(
      await collectRuntimeHealth({ runtimeVersion: RUNTIME_VERSION, env })
    );
    expect(findings.find((finding) => finding.title === 'Version')?.severity).toBe('warn');
  });

  it('treats a config it cannot parse as a failure, not as an absent one', async () => {
    const env = await isolatedEnv();
    await Bun.write(join(env.MANGO_HOME as string, 'runtime/host/runtime.json'), '{');

    const report = await collectRuntimeHealth({ runtimeVersion: RUNTIME_VERSION, env });
    expect(report.lastError).toContain('not valid JSON');
    expect(worstSeverity(diagnoseRuntimeHealth(report))).toBe('fail');
  });
});
