import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RUNTIME_CAPABILITY_KEYS,
  RUNTIME_CONSENT_PRESETS,
  type RuntimeHealthReport,
  SHELL_TRUST_NOTICE,
} from '@mangostudio/shared/runtime-home';
import { parseRuntimeCliArgs } from '../../src/cli';
import {
  collectRuntimeHealth,
  diagnoseRuntimeHealth,
  diagnoseRuntimeServiceHealth,
  resolveRunningRuntimePlatformId,
  worstSeverity,
} from '../../src/health';
import { readRuntimeSlotConfig, writeRuntimeSlotConfig } from '../../src/runtime-home';
import {
  type RuntimeServiceExecDeps,
  renderSystemdUnit,
  shouldCheckRuntimeService,
} from '../../src/services/runtime-service';
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

/** Service-manager seams for the doctor branches, with nothing live behind them. */
function serviceDeps(options: {
  readonly env: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly sessionBus?: boolean;
  readonly currentBinaryPresent?: boolean;
  readonly unitInstalled?: boolean;
}): RuntimeServiceExecDeps {
  const bus = options.sessionBus ?? true;
  const unitBody = renderSystemdUnit(
    join(options.env.MANGO_HOME as string, 'runtime/remote/current/mangostudio-runtime'),
    'connect'
  );
  return {
    exec: (argv) => {
      if (argv.includes('is-enabled')) {
        return Promise.resolve({ exitCode: 0, stdout: 'enabled', stderr: '' });
      }
      if (argv.includes('is-active')) {
        return Promise.resolve({ exitCode: 0, stdout: 'active', stderr: '' });
      }
      if (argv[0] === 'loginctl') {
        return Promise.resolve({ exitCode: 0, stdout: 'Linger=yes', stderr: '' });
      }
      if (argv[0] === 'powershell.exe') {
        return Promise.resolve({ exitCode: 0, stdout: '{"installed":false}\r\n', stderr: '' });
      }
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    },
    platform: options.platform ?? 'linux',
    env: {
      ...options.env,
      ...(bus
        ? {
            XDG_RUNTIME_DIR: '/run/user/1000',
            DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
          }
        : {}),
    },
    home: '/home/test',
    uid: 1000,
    user: 'test',
    hasSystemd: () => Promise.resolve(true),
    writeFile: () => Promise.resolve(),
    readFile: (path) =>
      options.unitInstalled
        ? Promise.resolve(unitBody)
        : Promise.reject(new Error(`ENOENT ${path}`)),
    unlink: () => Promise.resolve(),
    mkdir: () => Promise.resolve(),
    pathExists: (path) =>
      Promise.resolve(path.endsWith('/bus') ? bus : (options.currentBinaryPresent ?? true)),
  };
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

  it('includes live external-agent target, age, and state in diagnostics', async () => {
    const env = await isolatedEnv();
    const report = await collectRuntimeHealth({
      runtimeVersion: RUNTIME_VERSION,
      env,
      externalAgents: {
        targets: ['codex'],
        liveSessionCount: 1,
        liveSessions: [
          {
            sessionId: 'session-1',
            targetId: 'codex',
            ageMs: 2_500,
            state: 'running',
          },
        ],
      },
    });

    expect(
      diagnoseRuntimeHealth(report).find((finding) => finding.title === 'External agents')?.detail
    ).toContain('codex:session-1 running 3s');
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

  it('does not treat a missing service on the host slot as a doctor defect', async () => {
    const env = await isolatedEnv();
    const report = await collectRuntimeHealth({ runtimeVersion: RUNTIME_VERSION, env });
    expect(report.slot).toBe('host');
    expect(shouldCheckRuntimeService({ slot: report.slot, hubUrl: null, serveListen: null })).toBe(
      false
    );
    expect(await diagnoseRuntimeServiceHealth(report)).toEqual([]);
  });

  // A machine where `service install` refuses must not be told to run it —
  // that would send the reader in a circle.
  it('points an unsupported platform at the manual path instead of a command that refuses', async () => {
    const env = await isolatedEnv();
    await writeRuntimeSlotConfig('remote', { hubUrl: 'wss://hub.test/api/runtime' }, env);
    const findings = await diagnoseRuntimeServiceHealth(
      { slot: 'remote' } as RuntimeHealthReport,
      env,
      serviceDeps({ platform: 'freebsd', env })
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.detail).toMatch(/supervise this runtime yourself/);
    expect(findings[0]?.fix).toBeUndefined();
  });

  // Windows installs a Scheduled Task now, so a missing one gets the same fix
  // every other platform gets.
  it('names service install as the fix on win32 when no task is registered', async () => {
    const env = await isolatedEnv();
    await writeRuntimeSlotConfig('remote', { hubUrl: 'wss://hub.test/api/runtime' }, env);
    const findings = await diagnoseRuntimeServiceHealth(
      { slot: 'remote' } as RuntimeHealthReport,
      env,
      serviceDeps({ platform: 'win32', env })
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.detail).toContain('no user-level service');
    expect(findings[0]?.fix).toBe('mangostudio-runtime service install --mode connect');
  });

  it('says it could not read the service without a session bus, not that none exists', async () => {
    const env = await isolatedEnv();
    await writeRuntimeSlotConfig('remote', { hubUrl: 'wss://hub.test/api/runtime' }, env);
    const findings = await diagnoseRuntimeServiceHealth(
      { slot: 'remote' } as RuntimeHealthReport,
      env,
      serviceDeps({ env, sessionBus: false })
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.detail).toContain('without a session bus');
    expect(findings[0]?.fix).toContain('XDG_RUNTIME_DIR');
  });

  it('fails with the missing path when the unit points at a current that holds nothing', async () => {
    const env = await isolatedEnv();
    await writeRuntimeSlotConfig('remote', { hubUrl: 'wss://hub.test/api/runtime' }, env);
    const deps = serviceDeps({ env, currentBinaryPresent: false, unitInstalled: true });
    const findings = await diagnoseRuntimeServiceHealth(
      { slot: 'remote' } as RuntimeHealthReport,
      env,
      deps
    );
    const missing = findings.find((finding) => finding.detail.includes('no runtime binary at'));
    expect(missing?.severity).toBe('fail');
    expect(missing?.detail).toContain(join(env.MANGO_HOME as string, 'runtime/remote/current'));
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

  it('names a missing audit field as an older binary rather than as off', async () => {
    const env = await isolatedEnv();
    await setup({ profile: 'readonly', yes: true }, { env });
    const report = await collectRuntimeHealth({ runtimeVersion: RUNTIME_VERSION, env });
    const { audit: _omit, ...withoutAudit } = report;

    const audit = diagnoseRuntimeHealth(withoutAudit).find((finding) => finding.title === 'Audit');
    expect(audit?.severity).toBe('ok');
    expect(audit?.detail).toContain('older binary');
  });

  it('warns when the audit log is enabled but its last write failed', async () => {
    const env = await isolatedEnv();
    await setup({ profile: 'readonly', yes: true }, { env });
    const report = await collectRuntimeHealth({ runtimeVersion: RUNTIME_VERSION, env });

    const audit = diagnoseRuntimeHealth({
      ...report,
      audit: { enabled: true },
      auditError: 'ENOSPC: no space left on device',
    }).find((finding) => finding.title === 'Audit');
    expect(audit?.severity).toBe('warn');
    expect(audit?.detail).toContain('ENOSPC');
    // The machine is often reachable only through the thing that is failing,
    // so the finding has to name the command that stops the bleeding.
    expect(audit?.fix).toContain('--audit off');
  });

  it('toggles audit alone once consent is recorded', async () => {
    const env = await isolatedEnv();
    await setup({ profile: 'full', yes: true }, { env });
    expect(
      (await collectRuntimeHealth({ runtimeVersion: RUNTIME_VERSION, env })).audit?.enabled
    ).toBe(false);

    const flipped = await setup({ audit: true, yes: true }, { env });
    expect(flipped.code).toBe(0);
    expect(flipped.lines.some((line) => line.includes('Audit on'))).toBe(true);
    expect(
      (await collectRuntimeHealth({ runtimeVersion: RUNTIME_VERSION, env })).audit?.enabled
    ).toBe(true);
  });

  it('defaults audit on for a remote slot', async () => {
    const env = await isolatedEnv();
    await setup({ profile: 'full', slot: 'remote', yes: true }, { env });
    expect(
      (await collectRuntimeHealth({ runtimeVersion: RUNTIME_VERSION, env, slot: 'remote' })).audit
        ?.enabled
    ).toBe(true);
  });
});
