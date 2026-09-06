import { describe, expect, it } from 'bun:test';
import {
  buildScriptEnv,
  installerArgv,
  selfInstallFlags,
  useVersionFlags,
} from '../../../../src/modules/updates/infrastructure/installer-invocation';

const noPwsh = () => null;
const hasPwsh = (name: string) => (name === 'pwsh' ? '/usr/bin/pwsh' : null);

describe('installerArgv', () => {
  it('runs a .sh script under bash with its flags appended', () => {
    expect(installerArgv('sh', '/tmp/install.sh', ['--prune'], noPwsh)).toEqual([
      'bash',
      '/tmp/install.sh',
      '--prune',
    ]);
  });

  it('wraps a .ps1 script in the non-interactive, policy-bypassed prelude', () => {
    expect(installerArgv('ps1', 'C:\\t\\install.ps1', ['-Prune'], noPwsh)).toEqual([
      'powershell.exe',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      'C:\\t\\install.ps1',
      '-Prune',
    ]);
  });

  it('prefers pwsh when the host has it', () => {
    expect(installerArgv('ps1', 'C:\\t\\install.ps1', [], hasPwsh)[0]).toBe('pwsh');
    expect(installerArgv('ps1', 'C:\\t\\install.ps1', [], noPwsh)[0]).toBe('powershell.exe');
  });
});

describe('selfInstallFlags', () => {
  it('passes the resolved version for every kind, so a canary smoke check compares the full string', () => {
    expect(selfInstallFlags('sh', '/tmp/a.tar.gz', '0.1.1-canary.abc1234')).toEqual([
      '--local',
      '/tmp/a.tar.gz',
      '--version',
      '0.1.1-canary.abc1234',
    ]);
  });

  it('uses the PowerShell flag spelling on ps1', () => {
    expect(selfInstallFlags('ps1', 'C:\\t\\a.zip', '0.1.1')).toEqual([
      '-Local',
      'C:\\t\\a.zip',
      '-Version',
      '0.1.1',
    ]);
  });
});

describe('useVersionFlags', () => {
  it('asks for a pointer swap only, per shell', () => {
    expect(useVersionFlags('sh', '0.1.0')).toEqual(['--use', '0.1.0']);
    expect(useVersionFlags('ps1', '0.1.0')).toEqual(['-Use', '0.1.0']);
  });
});

describe('buildScriptEnv', () => {
  const installedVia = {
    manager: 'self-managed' as const,
    channel: 'stable' as const,
    executable: '/home/j/.mango/dist/current/mangostudio',
    distRoot: '/home/j/.mango/dist',
    record: { origin: 'installer' as const, channel: 'stable' as const, version: '0.1.1' },
  };

  it('falls back to MANGOSTUDIO_BIN_DIR when a legacy install recorded no binDir', () => {
    // An install made before `binDir` was recorded has none, and this env
    // replaces rather than merges — so without the fallback the installer
    // writes the link into its default directory and the command already on
    // PATH keeps pointing at the old version, while the upgrade reports
    // success.
    const legacy = { ...installedVia, record: { ...installedVia.record } };

    const env = buildScriptEnv({ MANGOSTUDIO_BIN_DIR: '/opt/tools/bin' }, legacy);

    expect(env.MANGOSTUDIO_BIN_DIR).toBe('/opt/tools/bin');
  });

  it('prefers the recorded binDir over the environment', () => {
    // The record is what the last install actually wrote; an operator's env
    // must not silently retarget an install that already knows its own bin dir.
    const recorded = {
      ...installedVia,
      record: { ...installedVia.record, binDir: '/home/j/.local/bin' },
    };

    const env = buildScriptEnv({ MANGOSTUDIO_BIN_DIR: '/opt/tools/bin' }, recorded);

    expect(env.MANGOSTUDIO_BIN_DIR).toBe('/home/j/.local/bin');
  });

  it('carries the Windows system block install.ps1 needs to detect the host architecture and resolve executables', () => {
    // Get-Platform reads PROCESSOR_ARCHITECTURE/PROCESSOR_ARCHITEW6432; the
    // PowerShell 5.1 smoke check ("& $exe '--version'") needs PATHEXT to
    // treat mangostudio.exe as executable. Bun.spawn({ env }) replaces the
    // child's environment, so a key missing here is simply gone for the
    // script's whole run, not merged from this process's own environment.
    const env = buildScriptEnv(
      {
        PATH: 'C:\\Windows\\System32',
        PROCESSOR_ARCHITECTURE: 'AMD64',
        PROCESSOR_ARCHITEW6432: 'AMD64',
        PATHEXT: '.COM;.EXE;.BAT',
        SystemRoot: 'C:\\Windows',
      },
      installedVia
    );

    expect(env.PROCESSOR_ARCHITECTURE).toBe('AMD64');
    expect(env.PROCESSOR_ARCHITEW6432).toBe('AMD64');
    expect(env.PATHEXT).toBe('.COM;.EXE;.BAT');
    expect(env.SystemRoot).toBe('C:\\Windows');
  });

  it('never forwards a key the source env does not have', () => {
    const env = buildScriptEnv({ PATH: '/usr/bin' }, installedVia);

    expect(env.PROCESSOR_ARCHITECTURE).toBeUndefined();
    expect(env.PATHEXT).toBeUndefined();
  });

  it('always sets MANGOSTUDIO_INSTALL_ORIGIN=upgrade and the dist/bin dir overrides', () => {
    const env = buildScriptEnv(
      { PATH: '/usr/bin' },
      {
        ...installedVia,
        record: { ...installedVia.record, binDir: '/home/j/.local/bin' },
      }
    );

    expect(env.MANGOSTUDIO_INSTALL_ORIGIN).toBe('upgrade');
    expect(env.MANGOSTUDIO_INSTALL_DIR).toBe('/home/j/.mango/dist');
    expect(env.MANGOSTUDIO_BIN_DIR).toBe('/home/j/.local/bin');
  });
});
