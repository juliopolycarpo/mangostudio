import { describe, expect, it } from 'bun:test';
import {
  parsePlatformProbe,
  RUNTIME_PLATFORM_IDS,
  resolveLinuxPlatformId,
  resolveRuntimePlatformId,
} from '@mangostudio/shared/runtime-home';
import { platformFromProbe } from '../../../../src/modules/environments/infrastructure/container-engine';

const GLIBC = 'ldd (Ubuntu GLIBC 2.35) 2.35';
const MUSL = 'musl libc (x86_64)';

describe('resolveRuntimePlatformId', () => {
  it('resolves Linux and Darwin arches', () => {
    expect(resolveRuntimePlatformId({ kernel: 'Linux', machine: 'x86_64', libc: GLIBC })).toBe(
      'linux-x64'
    );
    expect(resolveRuntimePlatformId({ kernel: 'Linux', machine: 'aarch64', libc: MUSL })).toBe(
      'linux-arm64-musl'
    );
    expect(resolveRuntimePlatformId({ kernel: 'Darwin', machine: 'arm64', libc: '' })).toBe(
      'darwin-arm64'
    );
    expect(resolveRuntimePlatformId({ kernel: 'Darwin', machine: 'x86_64', libc: '' })).toBe(
      'darwin-x64'
    );
  });

  it('returns null for Windows and unknown arches', () => {
    expect(
      resolveRuntimePlatformId({ kernel: 'Windows_NT', machine: 'x86_64', libc: '' })
    ).toBeNull();
    expect(resolveRuntimePlatformId({ kernel: 'Linux', machine: 'riscv64', libc: '' })).toBeNull();
  });

  it('keeps resolveLinuxPlatformId as a Linux-only narrowing', () => {
    expect(resolveLinuxPlatformId({ machine: 'x86_64', libc: GLIBC })).toBe('linux-x64');
    expect(resolveLinuxPlatformId({ machine: 'arm64', libc: MUSL })).toBe('linux-arm64-musl');
  });

  it('lists the six posix platform ids', () => {
    expect(RUNTIME_PLATFORM_IDS).toHaveLength(6);
    expect(RUNTIME_PLATFORM_IDS).toContain('linux-x64-musl');
    expect(RUNTIME_PLATFORM_IDS).toContain('darwin-arm64');
  });
});

describe('parsePlatformProbe', () => {
  it('reads the three lines the probe script prints', () => {
    expect(parsePlatformProbe(`Linux\nx86_64\n${GLIBC}\n`)).toEqual({
      ok: true,
      kernel: 'Linux',
      machine: 'x86_64',
      libc: GLIBC,
    });
  });

  // The case the dropped legacy fallback got wrong: a distribution whose `ldd`
  // writes nothing prints two lines, and reading them as machine-and-libc made
  // `uname -s` the machine on every one of those hosts.
  it('reads a silent ldd as an empty libc, not as a missing kernel', () => {
    expect(parsePlatformProbe('Linux\nx86_64\n')).toEqual({
      ok: true,
      kernel: 'Linux',
      machine: 'x86_64',
      libc: '',
    });
  });

  it('tolerates CRLF, surrounding blank lines, and a banner after the answer', () => {
    expect(parsePlatformProbe(`\r\n\r\nDarwin\r\narm64\r\n\r\n`)).toEqual({
      ok: true,
      kernel: 'Darwin',
      machine: 'arm64',
      libc: '',
    });
    expect(parsePlatformProbe(`Linux\naarch64\n${MUSL}\nsome trailing noise\n`)).toEqual({
      ok: true,
      kernel: 'Linux',
      machine: 'aarch64',
      libc: MUSL,
    });
  });

  it('reports an answer it cannot read rather than completing it', () => {
    for (const stdout of ['', '\n\n', 'Linux\n']) {
      expect(parsePlatformProbe(stdout).ok).toBe(false);
    }

    const parsed = parsePlatformProbe('Linux\n');
    expect(parsed).toEqual({ ok: false, reason: 'unexpected-shape', raw: 'Linux' });
  });

  it('bounds the output it quotes back', () => {
    const parsed = parsePlatformProbe('x'.repeat(5_000));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.raw.length).toBeLessThanOrEqual(201);
  });

  // The reason the parser is shared: a second reading is a second answer.
  it('gives the container transport the same reading it gives everyone', () => {
    const fixtures = [
      `Linux\nx86_64\n${GLIBC}\n`,
      'Linux\nx86_64\n',
      `Linux\naarch64\n${MUSL}\n`,
      'Darwin\narm64\n',
      'Linux\n',
      '',
    ];

    for (const stdout of fixtures) {
      const parsed = parsePlatformProbe(stdout);
      const shared = parsed.ok ? resolveRuntimePlatformId(parsed) : null;
      const expected = shared?.startsWith('linux-') ? shared : null;
      expect(platformFromProbe(stdout)).toBe(expected as never);
    }
  });
});
