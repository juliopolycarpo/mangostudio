import { describe, expect, test } from 'bun:test';

import { hostToolMissing, type HostToolProbe, zipCreationUnavailable } from './host-tools';

/** A host with a fixed PATH content, CI flag and platform that records its warnings. */
class FakeHost implements HostToolProbe {
  readonly warnings: string[] = [];

  constructor(
    private readonly installed: readonly string[],
    readonly ci: boolean,
    readonly platform: NodeJS.Platform = 'linux'
  ) {}

  which = (tool: string): string | null =>
    this.installed.includes(tool) ? `/usr/bin/${tool}` : null;

  warn = (message: string): void => {
    this.warnings.push(message);
  };
}

describe('hostToolMissing', () => {
  test('a tool on PATH is not missing and prints nothing', () => {
    const host = new FakeHost(['zip'], false);

    expect(hostToolMissing('zip', 'archive tests', host)).toBe(false);
    expect(host.warnings).toEqual([]);
  });

  test('outside CI an absent tool skips and names the tool and who needs it', () => {
    const host = new FakeHost([], false);

    expect(hostToolMissing('zip', 'archive tests', host)).toBe(true);
    expect(host.warnings).toEqual([
      'host tool (archive tests): expected `zip` on PATH | received: not found; skipping the tests that need it (install `zip` to run them)',
    ]);
  });

  test('in CI an absent tool throws instead of skipping', () => {
    const host = new FakeHost([], true);

    expect(() => hostToolMissing('zip', 'archive tests', host)).toThrow(
      'host tool (archive tests): expected `zip` on PATH | received: not found; CI must install it'
    );
    expect(host.warnings).toEqual([]);
  });
});

describe('zipCreationUnavailable', () => {
  test('Windows creates ZIPs through PowerShell and never asks for zip', () => {
    const host = new FakeHost([], true, 'win32');

    expect(zipCreationUnavailable(host)).toBe(false);
  });

  test('other platforms need the zip binary', () => {
    expect(zipCreationUnavailable(new FakeHost([], false, 'darwin'))).toBe(true);
    expect(zipCreationUnavailable(new FakeHost(['zip'], false, 'linux'))).toBe(false);
  });
});
