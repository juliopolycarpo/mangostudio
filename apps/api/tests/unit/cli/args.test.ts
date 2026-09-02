import { describe, expect, it } from 'bun:test';
import {
  assertValidPort,
  DEFAULT_LOG_LINES,
  parseDoctorArgs,
  parseLogsArgs,
  parseServeArgs,
  parseServiceArgs,
  parseStatusArgs,
} from '../../../src/cli/args';
import { CliError } from '../../../src/cli/errors';

describe('parseServeArgs', () => {
  it('defaults to no host, no port, and not detached', () => {
    expect(parseServeArgs([])).toEqual({ host: undefined, port: undefined, detached: false });
  });

  it('parses a positional port', () => {
    expect(parseServeArgs(['3000'])).toEqual({ host: undefined, port: 3000, detached: false });
  });

  it('parses a positional host', () => {
    expect(parseServeArgs(['127.0.0.1'])).toEqual({
      host: '127.0.0.1',
      port: undefined,
      detached: false,
    });
    expect(parseServeArgs(['localhost'])).toEqual({
      host: 'localhost',
      port: undefined,
      detached: false,
    });
  });

  it('parses -d and --detach', () => {
    expect(parseServeArgs(['-d'])).toEqual({ host: undefined, port: undefined, detached: true });
    expect(parseServeArgs(['--detach'])).toEqual({
      host: undefined,
      port: undefined,
      detached: true,
    });
  });

  it('parses the target and flag in either order', () => {
    expect(parseServeArgs(['3000', '-d'])).toEqual({ host: undefined, port: 3000, detached: true });
    expect(parseServeArgs(['-d', '127.0.0.1'])).toEqual({
      host: '127.0.0.1',
      port: undefined,
      detached: true,
    });
  });

  it('parses host:port targets', () => {
    expect(parseServeArgs(['127.0.0.1:3023', '-d'])).toEqual({
      host: '127.0.0.1',
      port: 3023,
      detached: true,
    });
    expect(parseServeArgs(['localhost:3023', '-d'])).toEqual({
      host: 'localhost',
      port: 3023,
      detached: true,
    });
    expect(parseServeArgs(['192.168.0.23:3023', '-d'])).toEqual({
      host: '192.168.0.23',
      port: 3023,
      detached: true,
    });
  });

  it('normalizes host aliases', () => {
    expect(parseServeArgs(['lan:3023', '-d'])).toEqual({
      host: '0.0.0.0',
      port: 3023,
      detached: true,
    });
    expect(parseServeArgs(['all'])).toEqual({ host: '0.0.0.0', port: undefined, detached: false });
    expect(parseServeArgs(['any'])).toEqual({ host: '0.0.0.0', port: undefined, detached: false });
    expect(parseServeArgs(['public'])).toEqual({
      host: '0.0.0.0',
      port: undefined,
      detached: false,
    });
    expect(parseServeArgs(['local'])).toEqual({
      host: '127.0.0.1',
      port: undefined,
      detached: false,
    });
  });

  it('rejects an unknown option', () => {
    expect(() => parseServeArgs(['--bogus'])).toThrow(CliError);
  });

  it('rejects a non-numeric port', () => {
    expect(() => parseServeArgs(['localhost:abc'])).toThrow(CliError);
  });

  it('rejects non-decimal numeric forms instead of silently coercing them', () => {
    expect(() => parseServeArgs(['0x10'])).toThrow(CliError);
    expect(() => parseServeArgs(['1e3'])).toThrow(CliError);
    expect(() => parseServeArgs(['3.5'])).toThrow(CliError);
    expect(() => parseServeArgs([' 3000 '])).toThrow(CliError);
    expect(() => parseServeArgs(['localhost:0x10'])).toThrow(CliError);
    expect(() => parseServeArgs(['localhost:1e3'])).toThrow(CliError);
    expect(() => parseServeArgs(['localhost:3.5'])).toThrow(CliError);
    expect(() => parseServeArgs(['localhost: 3000 '])).toThrow(CliError);
  });

  it('rejects a second positional argument', () => {
    expect(() => parseServeArgs(['3000', '4000'])).toThrow(CliError);
  });

  it('rejects invalid hosts', () => {
    expect(() => parseServeArgs(['999.1.1.1'])).toThrow(CliError);
    expect(() => parseServeArgs(['bad host'])).toThrow(CliError);
    expect(() => parseServeArgs(['host:'])).toThrow(CliError);
    expect(() => parseServeArgs([':3000'])).toThrow(CliError);
  });

  it('rejects an out-of-range port', () => {
    expect(() => parseServeArgs(['0'])).toThrow(CliError);
    expect(() => parseServeArgs(['99999'])).toThrow(CliError);
  });
});

describe('parseDoctorArgs', () => {
  it('defaults to no flags', () => {
    expect(parseDoctorArgs([])).toEqual({
      all: false,
      chatgptRefresh: false,
      probe: false,
      envOnly: false,
      libraryOnly: false,
      json: false,
    });
  });

  it('parses --all, --chatgpt-refresh, and --probe', () => {
    expect(parseDoctorArgs(['--all'])).toEqual({
      all: true,
      chatgptRefresh: false,
      probe: false,
      envOnly: false,
      libraryOnly: false,
      json: false,
    });
    expect(parseDoctorArgs(['--chatgpt-refresh'])).toEqual({
      all: false,
      chatgptRefresh: true,
      probe: false,
      envOnly: false,
      libraryOnly: false,
      json: false,
    });
    expect(parseDoctorArgs(['--probe'])).toEqual({
      all: false,
      chatgptRefresh: false,
      probe: true,
      envOnly: false,
      libraryOnly: false,
      json: false,
    });
    expect(parseDoctorArgs(['--all', '--chatgpt-refresh', '--probe'])).toEqual({
      all: true,
      chatgptRefresh: true,
      probe: true,
      envOnly: false,
      libraryOnly: false,
      json: false,
    });
  });

  it('parses --env, --library, and --json', () => {
    expect(parseDoctorArgs(['--env', '--json'])).toEqual({
      all: false,
      chatgptRefresh: false,
      probe: false,
      envOnly: true,
      libraryOnly: false,
      json: true,
    });
  });

  it('rejects unknown options', () => {
    expect(() => parseDoctorArgs(['--bogus'])).toThrow(CliError);
  });

  // Removed with the Cursor sidecar it probed. Asserted rather than assumed: a
  // silently accepted no-op flag would read as a probe that ran and passed.
  it('rejects the removed --cursor-probe flag', () => {
    expect(() => parseDoctorArgs(['--cursor-probe'])).toThrow(CliError);
  });
});

describe('assertValidPort', () => {
  it('accepts the boundary ports', () => {
    expect(() => assertValidPort(1)).not.toThrow();
    expect(() => assertValidPort(65_535)).not.toThrow();
  });

  it('rejects ports outside the range', () => {
    expect(() => assertValidPort(0)).toThrow(CliError);
    expect(() => assertValidPort(65_536)).toThrow(CliError);
  });
});

describe('parseStatusArgs', () => {
  it('accepts --json and nothing else', () => {
    expect(parseStatusArgs([])).toEqual({ json: false });
    expect(parseStatusArgs(['--json'])).toEqual({ json: true });
    expect(() => parseStatusArgs(['--verbose'])).toThrow(CliError);
  });
});

describe('parseServiceArgs', () => {
  it('requires a known action', () => {
    expect(() => parseServiceArgs([])).toThrow(/Missing service action/);
    expect(() => parseServiceArgs(['enable'])).toThrow(/Unknown service action: enable/);
  });

  it('parses each action with an optional --json', () => {
    expect(parseServiceArgs(['status', '--json'])).toEqual({
      action: 'status',
      host: undefined,
      port: undefined,
      json: true,
    });
    expect(parseServiceArgs(['restart'])).toEqual({
      action: 'restart',
      host: undefined,
      port: undefined,
      json: false,
    });
  });

  it('accepts a bind target for install only', () => {
    expect(parseServiceArgs(['install', 'lan:3000'])).toEqual({
      action: 'install',
      host: '0.0.0.0',
      port: 3000,
      json: false,
    });
    expect(() => parseServiceArgs(['install', '3000', '3001'])).toThrow(/Unexpected argument/);
    expect(() => parseServiceArgs(['stop', '3000'])).toThrow(
      /Unexpected argument for service stop/
    );
    expect(() => parseServiceArgs(['install', '--now'])).toThrow(/Unknown option for service/);
  });
});

describe('parseLogsArgs', () => {
  it('defaults to a bounded tail without following', () => {
    expect(parseLogsArgs([])).toEqual({ follow: false, lines: DEFAULT_LOG_LINES });
  });

  it('parses follow and a line count', () => {
    expect(parseLogsArgs(['-f', '-n', '50'])).toEqual({ follow: true, lines: 50 });
    expect(parseLogsArgs(['--lines', '5', '--follow'])).toEqual({ follow: true, lines: 5 });
  });

  it('rejects a missing, non-numeric, or out-of-range count', () => {
    expect(() => parseLogsArgs(['-n'])).toThrow(/Expected a line count/);
    expect(() => parseLogsArgs(['-n', 'ten'])).toThrow(/Expected a line count/);
    expect(() => parseLogsArgs(['-n', '0'])).toThrow(/out of range/);
    expect(() => parseLogsArgs(['--tail'])).toThrow(/Unknown option for logs/);
  });
});
