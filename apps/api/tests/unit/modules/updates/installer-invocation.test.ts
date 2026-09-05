import { describe, expect, it } from 'bun:test';
import {
  buildScriptEnv,
  installerArgv,
  powershellInterpreter,
  selfInstallArgv,
  useVersionArgv,
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
    expect(powershellInterpreter(noPwsh)).toBe('powershell.exe');
  });
});

describe('selfInstallArgv', () => {
  it('passes the resolved version for every kind, so a canary smoke check compares the full string', () => {
    expect(
      selfInstallArgv('sh', '/tmp/install.sh', '/tmp/a.tar.gz', '0.1.1-canary.abc1234', noPwsh)
    ).toEqual([
      'bash',
      '/tmp/install.sh',
      '--local',
      '/tmp/a.tar.gz',
      '--version',
      '0.1.1-canary.abc1234',
    ]);
  });

  it('uses the PowerShell flag spelling on ps1', () => {
    expect(
      selfInstallArgv('ps1', 'C:\\t\\i.ps1', 'C:\\t\\a.zip', '0.1.1', noPwsh).slice(6)
    ).toEqual(['C:\\t\\i.ps1', '-Local', 'C:\\t\\a.zip', '-Version', '0.1.1']);
  });
});

describe('useVersionArgv', () => {
  it('asks for a pointer swap only, per shell', () => {
    expect(useVersionArgv('sh', '/tmp/install.sh', '0.1.0', noPwsh)).toEqual([
      'bash',
      '/tmp/install.sh',
      '--use',
      '0.1.0',
    ]);
    expect(useVersionArgv('ps1', 'C:\\t\\i.ps1', '0.1.0', noPwsh).slice(6)).toEqual([
      'C:\\t\\i.ps1',
      '-Use',
      '0.1.0',
    ]);
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
