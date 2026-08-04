import { describe, expect, it } from 'bun:test';
import {
  RUNTIME_PLATFORM_IDS,
  resolveLinuxPlatformId,
  resolveRuntimePlatformId,
} from '@mangostudio/shared/runtime-home';

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
