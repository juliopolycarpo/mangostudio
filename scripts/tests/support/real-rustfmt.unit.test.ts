import { describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

import { discoverRealRustfmt, realRustfmtEnvironment } from './real-rustfmt';

const executable = join(
  tmpdir(),
  'pinned-toolchain',
  'bin',
  process.platform === 'win32' ? 'rustfmt.exe' : 'rustfmt'
);
const rustup = join(
  tmpdir(),
  'rustup-proxy',
  process.platform === 'win32' ? 'rustup.exe' : 'rustup'
);

class FormatterDiscovery {
  hasRustup = true;
  fallback: string | null = executable;
  fileExists = true;
  queryFailure?: Error;
  result: { exitCode: number | null; stdout: string; stderr: string } = {
    exitCode: 0,
    stdout: `${executable}\n`,
    stderr: '',
  };
  help: { exitCode: number | null; stdout: string; stderr: string } = {
    exitCode: 0,
    stdout: 'rustup 1.29.1 (fixture)\n\nThe Rust toolchain installer\n',
    stderr: '',
  };
  readonly commands: string[][] = [];
  readonly environments: (NodeJS.ProcessEnv | undefined)[] = [];
  readonly files: string[] = [];

  which(command: string): string | null {
    return command === 'rustup' ? (this.hasRustup ? rustup : null) : this.fallback;
  }

  query(command: string[], env?: NodeJS.ProcessEnv) {
    this.commands.push(command);
    this.environments.push(env);
    if (this.queryFailure) throw this.queryFailure;
    return command[1] === '--help' ? this.help : this.result;
  }

  isFile(path: string): boolean {
    this.files.push(path);
    return this.fileExists;
  }
}

class NativeFormatterProbe {
  readonly calls: {
    command: string[];
    autoInstall: string | undefined;
    timeout: number | undefined;
  }[] = [];

  constructor(private readonly formatter: string) {}

  which = (name: string): string | null => {
    if (name !== 'rustup') throw new Error(`expected rustup lookup | received: ${name}`);
    return rustup;
  };

  spawn = (command: string[], options: { env?: NodeJS.ProcessEnv; timeout?: number }) => {
    this.calls.push({
      command,
      autoInstall: options.env?.RUSTUP_AUTO_INSTALL,
      timeout: options.timeout,
    });
    let output: string;
    if (command[0] !== rustup) throw new Error(`expected ${rustup} | received: ${command[0]}`);
    if (command[1] === '--help' && command.length === 2) output = 'rustup 1.29.1 (fixture)\n';
    else if (command[1] === 'which' && command[2] === 'rustfmt' && command.length === 3)
      output = `${this.formatter}\n`;
    else throw new Error(`unexpected rustup query: ${JSON.stringify(command)}`);
    return {
      exitCode: 0,
      stdout: new TextEncoder().encode(output),
      stderr: new Uint8Array(),
    } as ReturnType<typeof Bun.spawnSync>;
  };
}

describe('real formatter discovery', () => {
  it('passes the non-installing environment and deadline through the native spawn adapter', () => {
    const directory = mkdtempSync(join(tmpdir(), 'real-rustfmt-native-adapter-'));
    const formatter = join(directory, process.platform === 'win32' ? 'rustfmt.exe' : 'rustfmt');
    writeFileSync(formatter, 'fixture');
    const fake = new NativeFormatterProbe(formatter);
    const previous = process.env.RUSTUP_AUTO_INSTALL;
    const which = spyOn(Bun, 'which').mockImplementation(fake.which as typeof Bun.which);
    const spawn = spyOn(Bun, 'spawnSync').mockImplementation(fake.spawn as typeof Bun.spawnSync);
    try {
      expect(discoverRealRustfmt().path).toBe(formatter);
      expect(fake.calls).toEqual([
        { command: [rustup, '--help'], autoInstall: '0', timeout: 5000 },
        { command: [rustup, 'which', 'rustfmt'], autoInstall: '0', timeout: 5000 },
      ]);
      expect(process.env.RUSTUP_AUTO_INSTALL).toBe(previous);
    } finally {
      spawn.mockRestore();
      which.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('uses the installed executable returned by the selected rustup', () => {
    const discovery = new FormatterDiscovery();
    expect(discoverRealRustfmt(discovery)).toEqual({
      path: executable,
      source: 'rustup',
      command: [rustup, 'which', 'rustfmt'],
      exitCode: 0,
      stdout: `${executable}\n`,
      stderr: '',
    });
    expect(discovery.commands).toEqual([
      [rustup, '--help'],
      [rustup, 'which', 'rustfmt'],
    ]);
    expect(discovery.files).toEqual([executable]);
  });

  it('disables automatic installation only in the discovery child', () => {
    const discovery = new FormatterDiscovery();
    const previous = process.env.RUSTUP_AUTO_INSTALL;
    discoverRealRustfmt(discovery);
    expect(discovery.environments[0]?.RUSTUP_AUTO_INSTALL).toBe('0');
    expect(discovery.environments[1]?.RUSTUP_AUTO_INSTALL).toBe('0');
    expect(process.env.RUSTUP_AUTO_INSTALL).toBe(previous);
  });

  it('refuses old rustup before it can run an installing lookup', () => {
    const discovery = new FormatterDiscovery();
    discovery.help.stdout = 'rustup 1.27.1 (fixture)\n';
    expect(() => discoverRealRustfmt(discovery)).toThrow('rustup 1.28.1 or newer');
    expect(discovery.commands).toEqual([[rustup, '--help']]);
  });

  it.each([
    { exitCode: 0, stdout: '', stderr: '' },
    { exitCode: 0, stdout: 'rustup 1.29.1-dev (fixture)\n', stderr: '' },
    { exitCode: null, stdout: 'rustup 1.29.1 (fixture)\n', stderr: 'timed out' },
    { exitCode: 1, stdout: 'rustup 1.29.1 (fixture)\n', stderr: 'permission denied' },
  ])('refuses unverifiable rustup help output %# before lookup', (help) => {
    const discovery = new FormatterDiscovery();
    discovery.help = help;
    expect(() => discoverRealRustfmt(discovery)).toThrow('rustup 1.28.1 or newer');
    expect(discovery.commands).toEqual([[rustup, '--help']]);
  });

  it.each(['1.28.1', '1.29.0', '2.0.0'])(
    'accepts rustup version %s that supports disabling auto-install',
    (version) => {
      const discovery = new FormatterDiscovery();
      discovery.help.stdout = `rustup ${version} (fixture)\n`;
      expect(discoverRealRustfmt(discovery).path).toBe(executable);
      expect(discovery.commands).toEqual([
        [rustup, '--help'],
        [rustup, 'which', 'rustfmt'],
      ]);
    }
  );

  it('reports a confirmed missing toolchain without installing it', () => {
    const discovery = new FormatterDiscovery();
    discovery.result = {
      exitCode: 1,
      stdout: '',
      stderr:
        "error: toolchain '1.99.0-x86_64-unknown-linux-gnu' is not installed\nhelp: run `rustup toolchain install` to install it\n",
    };
    expect(discoverRealRustfmt(discovery).unavailable).toBe(
      'the pinned Rust toolchain is unavailable'
    );
  });

  it('reports Bun null-exit timeout instead of treating a partial diagnostic as absence', () => {
    const discovery = new FormatterDiscovery();
    discovery.result = {
      exitCode: null,
      stdout: '',
      stderr:
        "error: toolchain '1.99.0-x86_64-unknown-linux-gnu' is not installed\nhelp: run `rustup toolchain install` to install it\n",
    };
    expect(() => discoverRealRustfmt(discovery)).toThrow('"exitCode":null');
  });

  it.each([
    { exitCode: 1, stdout: 'partial', stderr: "error: toolchain 'fixture' is not installed\n" },
    {
      exitCode: 1,
      stdout: '',
      stderr: "error: toolchain 'fixture' is not installed\nerror: permission denied\n",
    },
    { exitCode: 1, stdout: '', stderr: 'error: some unrelated item is not installed\n' },
  ])('does not suppress ambiguous missing-toolchain diagnostics %#', (result) => {
    const discovery = new FormatterDiscovery();
    discovery.result = result;
    expect(() => discoverRealRustfmt(discovery)).toThrow('confirmed missing');
  });

  it('reports a confirmed missing rustfmt component without accepting an output path', () => {
    const discovery = new FormatterDiscovery();
    discovery.result = {
      exitCode: 1,
      stdout: '',
      stderr:
        "error: 'rustfmt' is not installed for the toolchain 'fixture'.\nhelp: run `rustup component add rustfmt` to install it\n",
    };
    expect(discoverRealRustfmt(discovery)).toEqual({
      source: 'rustup',
      command: [rustup, 'which', 'rustfmt'],
      ...discovery.result,
      unavailable: 'the pinned rustfmt component is unavailable',
    });
    expect(discovery.files).toEqual([]);
    expect(discovery.commands).toEqual([
      [rustup, '--help'],
      [rustup, 'which', 'rustfmt'],
    ]);
  });

  it('reports a timed-out lookup instead of skipping', () => {
    const discovery = new FormatterDiscovery();
    discovery.result = { exitCode: 124, stdout: '', stderr: 'lookup timed out' };
    expect(() => discoverRealRustfmt(discovery)).toThrow(
      `expected a successful rustfmt lookup or confirmed missing component or toolchain | received: ${JSON.stringify({ command: [rustup, 'which', 'rustfmt'], ...discovery.result })}`
    );
    expect(discovery.files).toEqual([]);
  });

  it('reports a permission failure rather than declaring a component missing', () => {
    const discovery = new FormatterDiscovery();
    discovery.result = { exitCode: 1, stdout: '', stderr: 'permission denied' };
    expect(() => discoverRealRustfmt(discovery)).toThrow('permission denied');
  });

  it('bounds discovery output while retaining the command and failure status', () => {
    const discovery = new FormatterDiscovery();
    discovery.result = { exitCode: 1, stdout: 'a'.repeat(5000), stderr: 'b'.repeat(5000) };
    let message = '';
    try {
      discoverRealRustfmt(discovery);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      message = error.message;
    }
    expect(message).toContain(JSON.stringify([rustup, 'which', 'rustfmt']));
    expect(message).toContain('"exitCode":1');
    expect(message).toContain('[truncated, 5000 characters]');
    expect(message.length).toBeLessThan(5000);
  });

  it('recognizes the confirmed missing component diagnostic with Windows line endings', () => {
    const discovery = new FormatterDiscovery();
    discovery.result = {
      exitCode: 1,
      stdout: '',
      stderr:
        "error: 'rustfmt' is not installed for the toolchain 'fixture'.\r\nhelp: run `rustup component add rustfmt` to install it\r\n",
    };
    expect(discoverRealRustfmt(discovery).unavailable).toBe(
      'the pinned rustfmt component is unavailable'
    );
  });

  it('does not classify a timed-out missing-component diagnostic as absence', () => {
    const discovery = new FormatterDiscovery();
    discovery.result = {
      exitCode: 124,
      stdout: '',
      stderr: "error: 'rustfmt' is not installed for the toolchain 'fixture'.\n",
    };
    expect(() => discoverRealRustfmt(discovery)).toThrow('confirmed missing component');
  });

  it.each([
    {
      stdout: executable,
      stderr: "error: 'rustfmt' is not installed for the toolchain 'fixture'.\n",
    },
    {
      stdout: '',
      stderr:
        "error: 'rustfmt' is not installed for the toolchain 'fixture'.\nerror: permission denied\n",
    },
    { stdout: '', stderr: "error: 'cargo' is not installed for the toolchain 'fixture'.\n" },
  ])('rejects ambiguous component lookup output %#', ({ stdout, stderr }) => {
    const discovery = new FormatterDiscovery();
    discovery.result = { exitCode: 1, stdout, stderr };
    expect(() => discoverRealRustfmt(discovery)).toThrow('confirmed missing component');
  });

  it('preserves a discovery execution error instead of declaring a formatter available', () => {
    const discovery = new FormatterDiscovery();
    const failure = new Error('rustup executable could not start');
    discovery.queryFailure = failure;
    let received: unknown;
    try {
      discoverRealRustfmt(discovery);
    } catch (error) {
      received = error;
    }
    expect(received).toBe(failure);
    expect(discovery.files).toEqual([]);
  });

  it.each(['', 'relative/rustfmt', join(dirname(executable), 'other-tool')])(
    'rejects successful discovery with invalid executable path %j',
    (invalid) => {
      const discovery = new FormatterDiscovery();
      discovery.result.stdout = `${invalid}\n`;
      expect(() => discoverRealRustfmt(discovery)).toThrow(
        `expected an absolute existing rustfmt executable path | received: ${JSON.stringify(invalid)}`
      );
    }
  );

  it('rejects a discovered path that is not an existing file', () => {
    const discovery = new FormatterDiscovery();
    discovery.fileExists = false;
    expect(() => discoverRealRustfmt(discovery)).toThrow(JSON.stringify(executable));
    expect(discovery.files).toEqual([executable]);
  });

  it('uses a real PATH executable when rustup is absent', () => {
    const discovery = new FormatterDiscovery();
    discovery.hasRustup = false;
    expect(discoverRealRustfmt(discovery)).toEqual({
      path: executable,
      source: 'path',
      command: [],
      stdout: executable,
      stderr: '',
    });
    expect(discovery.commands).toEqual([]);
  });

  it('retains the unavailable reason when neither formatter nor rustup exists', () => {
    const discovery = new FormatterDiscovery();
    discovery.hasRustup = false;
    discovery.fallback = null;
    expect(discoverRealRustfmt(discovery)).toEqual({
      source: 'path',
      command: [],
      stdout: '',
      stderr: '',
      unavailable: 'rustfmt is not on PATH',
    });
  });

  it('rejects a malformed PATH fallback instead of declaring it installed', () => {
    const discovery = new FormatterDiscovery();
    discovery.hasRustup = false;
    discovery.fallback = 'rustfmt';
    expect(() => discoverRealRustfmt(discovery)).toThrow('received: "rustfmt"');
  });
});

describe('real formatter child environment', () => {
  it('prepends the selected executable directory and preserves unrelated environment entries', () => {
    const ambient = { PATH: 'earlier-proxy', HOME: 'owned-home', TOKEN: 'fixture-token' };
    expect(realRustfmtEnvironment(executable, ambient)).toEqual({
      ...ambient,
      PATH: `${dirname(executable)}${delimiter}earlier-proxy`,
    });
    expect(ambient.PATH).toBe('earlier-proxy');
  });

  it('gives a Windows-style ambient environment exactly one PATH key', () => {
    const ambient = { Path: 'mixed-path', PATH: 'explicit-path', pAtH: 'other-path', KEEP: 'yes' };
    const environment = realRustfmtEnvironment(executable, ambient);
    expect(environment).toEqual({
      KEEP: 'yes',
      PATH: `${dirname(executable)}${delimiter}explicit-path`,
    });
    expect(Object.keys(environment).filter((key) => key.toLowerCase() === 'path')).toEqual([
      'PATH',
    ]);
    expect(ambient).toEqual({
      Path: 'mixed-path',
      PATH: 'explicit-path',
      pAtH: 'other-path',
      KEEP: 'yes',
    });
  });

  it('preserves inherited Path when no uppercase PATH exists', () => {
    expect(realRustfmtEnvironment(executable, { Path: 'inherited' })).toEqual({
      PATH: `${dirname(executable)}${delimiter}inherited`,
    });
  });

  it('selects the real directory when the child has no ambient PATH', () => {
    expect(realRustfmtEnvironment(executable, {})).toEqual({
      PATH: `${dirname(executable)}${delimiter}`,
    });
  });
});
