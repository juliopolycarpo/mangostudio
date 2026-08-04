import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RUNTIME_CAPABILITY_KEYS,
  RUNTIME_CONSENT_PRESETS,
  SHELL_TRUST_NOTICE,
} from '@mangostudio/shared/runtime-home';
import { parseRuntimeCliArgs } from '../../src/cli';
import {
  collectRuntimeHealth,
  diagnoseRuntimeHealth,
  resolveRunningRuntimePlatformId,
  worstSeverity,
} from '../../src/health';
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

  it('lets an explicit profile override an environment answer it cannot use', async () => {
    // Flags outrank the environment, so the command that repairs a machine
    // whose MANGOSTUDIO_RUNTIME_SETUP went stale must not be blocked by it.
    const env = await isolatedEnv({ MANGOSTUDIO_RUNTIME_SETUP: 'everything' });
    const run = await setup({ profile: 'readonly', yes: true }, { env });

    expect(run.code).toBe(0);
    const config = await readRuntimeSlotConfig('host', env);
    expect(config.profile).toBe('readonly');
    expect(config.setup.by).toBe('cli');
  });

  it('answers for the slot it was pointed at, not the one it sits in', async () => {
    // `connect` and `serve` write the `remote` slot wherever the binary lives,
    // so the setup they recommend has to be able to reach the same file.
    const env = await isolatedEnv();
    const run = await setup({ profile: 'readonly', slot: 'remote', yes: true }, { env });

    expect(run.code).toBe(0);
    expect((await readRuntimeSlotConfig('remote', env)).profile).toBe('readonly');
    // The slot this binary sits in is untouched, and still unanswered.
    expect((await readRuntimeSlotConfig('host', env)).setup.at).toBeUndefined();
  });

  it('reports on the slot it answered for', async () => {
    const env = await isolatedEnv();
    const run = await setup({ profile: 'none', slot: 'remote', json: true }, { env });

    expect(run.code).toBe(0);
    expect(JSON.parse(run.lines[0] ?? '{}')).toMatchObject({ slot: 'remote', profile: 'none' });
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
    const { stdioConsent } = await import('../../src/cli');
    const env = await isolatedEnv();
    await writeRuntimeSlotConfig('remote', { setup: { state: 'pending' } }, env);
    const remoteBinary = join(env.MANGO_HOME as string, 'runtime', 'remote', 'current', 'x');
    expect((await stdioConsent(env, [remoteBinary])).refusal).not.toBeNull();

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
    expect((await stdioConsent(env, [remoteBinary])).refusal).not.toBeNull();
  });
});

describe('runtime health', () => {
  it('reports the exact glibc or musl release asset identity', () => {
    expect(resolveRunningRuntimePlatformId('linux', 'x64', '2.39')).toBe('linux-x64');
    expect(resolveRunningRuntimePlatformId('linux', 'x64', null)).toBe('linux-x64-musl');
    expect(resolveRunningRuntimePlatformId('linux', 'arm64', null)).toBe('linux-arm64-musl');
    expect(resolveRunningRuntimePlatformId('darwin', 'arm64', null)).toBe('darwin-arm64');
    expect(resolveRunningRuntimePlatformId('win32', 'x64', null)).toBeNull();
  });

  it('reports the slot, its consent, and where the bytes are', async () => {
    const env = await isolatedEnv();
    await setup({ profile: 'readonly', yes: true }, { env });

    const report = await collectRuntimeHealth({ runtimeVersion: RUNTIME_VERSION, env });
    expect(report.slot).toBe('host');
    expect(report.profile).toBe('readonly');
    expect(report.setup.state).toBe('configured');
    expect(report.runtimeVersion).toBe(RUNTIME_VERSION);
    expect(report.platformId).toMatch(/^(linux|darwin)-(x64|arm64)(-musl)?$/);
    expect(report.lastError).toBeNull();
    // The test process is Bun running a workspace entry, so there is no binary.
    expect(report.binaryPath).toBeNull();
    expect(report.source).toBe('source-checkout');
    // Host defaults audit off; setup without --audit leaves that default.
    expect(report.audit).toEqual({ enabled: false });
  });

  it('fails doctor on a slot nobody has answered for, and names the fix', async () => {
    const env = await isolatedEnv();
    await writeRuntimeSlotConfig('host', { setup: { state: 'pending' } }, env);

    const findings = diagnoseRuntimeHealth(
      await collectRuntimeHealth({ runtimeVersion: RUNTIME_VERSION, env })
    );
    const consent = findings.find((finding) => finding.title === 'Consent');
    expect(consent?.severity).toBe('fail');
    expect(consent?.fix).toBe('mangostudio-runtime setup --slot host');
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

  it('only ever prints a fix that setup would accept', async () => {
    // A doctor whose advertised fix exits on "Nothing to answer with" is worse
    // than one that says nothing: the reader believes they tried the fix.
    const env = await isolatedEnv();
    await writeRuntimeSlotConfig('host', { version: '0.0.1', setup: { state: 'pending' } }, env);

    const findings = diagnoseRuntimeHealth(
      await collectRuntimeHealth({ runtimeVersion: RUNTIME_VERSION, env })
    );
    const fixes = findings.flatMap((finding) => (finding.fix ? [finding.fix] : []));
    expect(fixes.length).toBeGreaterThan(0);

    for (const fix of fixes) {
      const parsed = parseRuntimeCliArgs(fix.replace('mangostudio-runtime ', '').split(' '));
      expect(parsed.command).toBe('setup');
      // `--yes` with no profile is rejected at run time, not at parse time, so
      // parsing alone would not have caught the command doctor used to print.
      const run = await setup((parsed as { args: RuntimeSetupArgs }).args, { env, answers: ['2'] });
      expect(run.code).toBe(0);
    }
  });

  it('treats a config it cannot parse as a failure, not as an absent one', async () => {
    const env = await isolatedEnv();
    await Bun.write(join(env.MANGO_HOME as string, 'runtime/host/runtime.json'), '{');

    const report = await collectRuntimeHealth({ runtimeVersion: RUNTIME_VERSION, env });
    expect(report.lastError).toContain('not valid JSON');
    expect(worstSeverity(diagnoseRuntimeHealth(report))).toBe('fail');
  });

  it('refuses every capability in the report a config it cannot read produces', async () => {
    // The slot default behind an unreadable `host` config is full consent, and
    // this payload is what the hub caches as the machine's manifest. Reporting
    // that default would advertise capabilities the dispatch gate — which
    // applies `none` to the same failure — refuses on every call.
    const env = await isolatedEnv();
    await Bun.write(join(env.MANGO_HOME as string, 'runtime/host/runtime.json'), '{');

    const report = await collectRuntimeHealth({ runtimeVersion: RUNTIME_VERSION, env });
    expect(report.profile).toBe('none');
    expect(Object.values(report.allow).every((granted) => granted === false)).toBe(true);
    expect(report.shells).toEqual([]);
    expect(report.git.available).toBe(false);

    const consent = diagnoseRuntimeHealth(report).find((finding) => finding.title === 'Consent');
    expect(consent?.severity).toBe('fail');
    expect(consent?.detail).toContain('could not be read');
  });

  it('toggles audit alone once consent is recorded', async () => {
    const env = await isolatedEnv();
    await setup({ profile: 'full', yes: true }, { env });
    expect(
      (await collectRuntimeHealth({ runtimeVersion: RUNTIME_VERSION, env })).audit.enabled
    ).toBe(false);

    const flipped = await setup({ audit: true, yes: true }, { env });
    expect(flipped.code).toBe(0);
    expect(flipped.lines.some((line) => line.includes('Audit on'))).toBe(true);
    expect(
      (await collectRuntimeHealth({ runtimeVersion: RUNTIME_VERSION, env })).audit.enabled
    ).toBe(true);
  });

  it('defaults audit on for a remote slot', async () => {
    const env = await isolatedEnv();
    await setup({ profile: 'full', slot: 'remote', yes: true }, { env });
    expect(
      (await collectRuntimeHealth({ runtimeVersion: RUNTIME_VERSION, env, slot: 'remote' })).audit
        .enabled
    ).toBe(true);
  });
});
