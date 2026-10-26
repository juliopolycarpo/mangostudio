import { describe, expect, it } from 'bun:test';
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
  result = { exitCode: 0, stdout: `${executable}\n`, stderr: '' };
  readonly commands: string[][] = [];
  readonly files: string[] = [];

  which(command: string): string | null {
    return command === 'rustup' ? (this.hasRustup ? rustup : null) : this.fallback;
  }

  query(command: string[]) {
    this.commands.push(command);
    if (this.queryFailure) throw this.queryFailure;
    return this.result;
  }

  isFile(path: string): boolean {
    this.files.push(path);
    return this.fileExists;
  }
}

describe('real formatter discovery', () => {
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
    expect(discovery.commands).toEqual([[rustup, 'which', 'rustfmt']]);
    expect(discovery.files).toEqual([executable]);
  });

  it('retains failed component discovery without accepting its stdout as a path', () => {
    const discovery = new FormatterDiscovery();
    discovery.result = { exitCode: 1, stdout: executable, stderr: 'component not installed' };
    expect(discoverRealRustfmt(discovery)).toEqual({
      source: 'rustup',
      command: [rustup, 'which', 'rustfmt'],
      ...discovery.result,
      unavailable: 'the pinned rustfmt component is unavailable',
    });
    expect(discovery.files).toEqual([]);
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
