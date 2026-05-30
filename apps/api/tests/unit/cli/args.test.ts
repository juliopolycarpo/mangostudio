import { describe, expect, it } from 'bun:test';
import { assertValidPort, parseServeArgs } from '../../../src/cli/args';
import { CliError } from '../../../src/cli/errors';

describe('parseServeArgs', () => {
  it('defaults to no port and not detached', () => {
    expect(parseServeArgs([])).toEqual({ port: undefined, detached: false });
  });

  it('parses a positional port', () => {
    expect(parseServeArgs(['3000'])).toEqual({ port: 3000, detached: false });
  });

  it('parses -d and --detach', () => {
    expect(parseServeArgs(['-d'])).toEqual({ port: undefined, detached: true });
    expect(parseServeArgs(['--detach'])).toEqual({ port: undefined, detached: true });
  });

  it('parses the port and flag in either order', () => {
    expect(parseServeArgs(['3000', '-d'])).toEqual({ port: 3000, detached: true });
    expect(parseServeArgs(['-d', '3000'])).toEqual({ port: 3000, detached: true });
  });

  it('rejects an unknown option', () => {
    expect(() => parseServeArgs(['--bogus'])).toThrow(CliError);
  });

  it('rejects a non-numeric port', () => {
    expect(() => parseServeArgs(['abc'])).toThrow(CliError);
  });

  it('rejects a second positional argument', () => {
    expect(() => parseServeArgs(['3000', '4000'])).toThrow(CliError);
  });

  it('rejects an out-of-range port', () => {
    expect(() => parseServeArgs(['0'])).toThrow(CliError);
    expect(() => parseServeArgs(['99999'])).toThrow(CliError);
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
