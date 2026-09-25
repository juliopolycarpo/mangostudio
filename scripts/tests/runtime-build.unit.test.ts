import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readExecutableHeader } from '../lib/executable-header';
import { ALL_BINARY_TARGETS, type ReleasePlatformId } from '../lib/release-targets';
import {
  canRunOnHost,
  cargoRuntimeBuildCommand,
  cargoRuntimeOutputPath,
  GLIBC_FLOOR,
  hostPlatformId,
  prebuiltRuntimePath,
  resolveRuntimeSource,
  runtimeHeaderProblems,
  runtimeVersionProblem,
  rustTargetTriple,
  selectRuntimeTargets,
  verifyRuntimeBinary,
} from '../lib/runtime-build';
import { fakeElf, fakeMachO, fakePe } from './support/executable-fixtures';
import { readText } from './support/read-text';
import { walkRuntimeImports } from './support/runtime-imports';

function target(platform: ReleasePlatformId) {
  const found = ALL_BINARY_TARGETS.find((candidate) => candidate.arch === platform);
  if (!found) throw new Error(`expected a release target for ${platform} | received: none`);
  return found;
}

describe('runtime target mapping', () => {
  test('maps every release platform to its Rust target triple', () => {
    expect(
      Object.fromEntries(ALL_BINARY_TARGETS.map(({ arch }) => [arch, rustTargetTriple(arch)]))
    ).toEqual({
      'linux-x64': 'x86_64-unknown-linux-gnu',
      'linux-arm64': 'aarch64-unknown-linux-gnu',
      'windows-x64': 'x86_64-pc-windows-msvc',
      'windows-arm64': 'aarch64-pc-windows-msvc',
      'darwin-x64': 'x86_64-apple-darwin',
      'darwin-arm64': 'aarch64-apple-darwin',
      'linux-x64-musl': 'x86_64-unknown-linux-musl',
      'linux-arm64-musl': 'aarch64-unknown-linux-musl',
    });
  });

  test('pins the glibc floor on gnu zig builds only', () => {
    expect(cargoRuntimeBuildCommand('linux-arm64', { zig: true })).toEqual([
      'cargo',
      'zigbuild',
      '--release',
      '--locked',
      '-p',
      'mangostudio-runtime',
      '--target',
      `aarch64-unknown-linux-gnu.${GLIBC_FLOOR}`,
    ]);
    expect(cargoRuntimeBuildCommand('linux-x64-musl', { zig: true }).slice(1)).toContain(
      'x86_64-unknown-linux-musl'
    );
    expect(cargoRuntimeBuildCommand('linux-x64', { zig: false })).toEqual([
      'cargo',
      'build',
      '--release',
      '--locked',
      '-p',
      'mangostudio-runtime',
      '--target',
      'x86_64-unknown-linux-gnu',
    ]);
    // zig is a Linux linker here; macOS and Windows keep their native toolchains.
    expect(cargoRuntimeBuildCommand('darwin-arm64', { zig: true })[1]).toBe('build');
  });

  test('glibc floor matches what the Bun hub already requires', () => {
    expect(GLIBC_FLOOR).toBe('2.17');
  });

  test('finds cargo output under the unsuffixed triple, with .exe on Windows', () => {
    expect(cargoRuntimeOutputPath('/repo/target', target('windows-arm64'))).toBe(
      join('/repo/target', 'aarch64-pc-windows-msvc', 'release', 'mangostudio-runtime.exe')
    );
  });

  test('names the host platform, or null off the release matrix', () => {
    expect(hostPlatformId('linux', 'x64')).toBe('linux-x64');
    expect(hostPlatformId('win32', 'arm64')).toBe('windows-arm64');
    expect(hostPlatformId('freebsd', 'x64')).toBeNull();
    expect(hostPlatformId('linux', 'ia32')).toBeNull();
  });

  test('a static musl runtime runs on a glibc host of the same CPU; nothing crosses OS or CPU', () => {
    expect(canRunOnHost('linux-x64-musl', 'linux-x64')).toBe(true);
    expect(canRunOnHost('linux-arm64', 'linux-x64')).toBe(false);
    expect(canRunOnHost('darwin-x64', 'linux-x64')).toBe(false);
    expect(canRunOnHost('linux-x64', null)).toBe(false);
  });

  test('selects platforms by id list and OS family, and names an unknown id', () => {
    expect(selectRuntimeTargets('linux-x64, windows-x64 darwin-arm64', 'linux')).toEqual([
      target('linux-x64'),
    ]);
    expect(selectRuntimeTargets(undefined, 'windows').map(({ arch }) => arch)).toEqual([
      'windows-x64',
      'windows-arm64',
    ]);
    expect(() => selectRuntimeTargets('linux-riscv64', undefined)).toThrow(
      '| received: linux-riscv64'
    );
    expect(() => selectRuntimeTargets(undefined, 'freebsd')).toThrow(
      'expected --os linux | darwin | windows | received: freebsd'
    );
  });
});

describe('resolveRuntimeSource', () => {
  test('stages a prebuilt runtime from <dir>/<platform>/', () => {
    expect(
      resolveRuntimeSource({
        target: target('windows-x64'),
        runtimeDir: '/prebuilt',
        hostPlatform: 'linux-x64',
        fileExists: () => true,
      })
    ).toEqual({
      kind: 'prebuilt',
      path: prebuiltRuntimePath('/prebuilt', target('windows-x64')),
    });
  });

  test('a missing prebuilt file is an error naming the file and layout, even for the host', () => {
    expect(() =>
      resolveRuntimeSource({
        target: target('linux-x64'),
        runtimeDir: '/prebuilt',
        hostPlatform: 'linux-x64',
        fileExists: () => false,
      })
    ).toThrow(
      `Missing prebuilt runtime for linux-x64: expected ${join('/prebuilt', 'linux-x64', 'mangostudio-runtime')}. A runtime directory holds <dir>/<platform-id>/mangostudio-runtime for every requested target; build it with \`bun run build:runtime --platform linux-x64 --out /prebuilt\`.`
    );
  });

  test('builds only the host target with cargo when no directory is given', () => {
    expect(
      resolveRuntimeSource({ target: target('linux-x64'), hostPlatform: 'linux-x64' })
    ).toEqual({
      kind: 'cargo',
      command: cargoRuntimeBuildCommand('linux-x64', { zig: false }),
    });
  });

  test('a non-host target with no directory fails with the expected path and flag', () => {
    expect(() =>
      resolveRuntimeSource({ target: target('linux-arm64'), hostPlatform: 'linux-x64' })
    ).toThrow(
      'No runtime binary for linux-arm64: this machine (linux-x64) only cargo-builds its own target. Pass --runtime-dir <dir> (or RUNTIME_DIR) where <dir>/linux-arm64/mangostudio-runtime is a prebuilt runtime'
    );
  });
});

describe('runtimeHeaderProblems', () => {
  const glibcX64 = (strings: string[]) =>
    readExecutableHeader(
      fakeElf({ arch: 'x64', interpreter: '/lib64/ld-linux-x86-64.so.2', strings })
    );

  test('accepts a matching header for each OS family', () => {
    const options = { enforceGlibcFloor: true };
    expect(runtimeHeaderProblems('linux-x64', glibcX64(['GLIBC_2.17']), options)).toEqual([]);
    expect(
      runtimeHeaderProblems(
        'linux-arm64-musl',
        readExecutableHeader(fakeElf({ arch: 'arm64', interpreter: null })),
        options
      )
    ).toEqual([]);
    expect(
      runtimeHeaderProblems('darwin-x64', readExecutableHeader(fakeMachO('x64')), options)
    ).toEqual([]);
    expect(
      runtimeHeaderProblems('windows-arm64', readExecutableHeader(fakePe('arm64')), options)
    ).toEqual([]);
  });

  test('names a wrong format or CPU', () => {
    expect(
      runtimeHeaderProblems('windows-arm64', readExecutableHeader(fakePe('x64')), {
        enforceGlibcFloor: true,
      })
    ).toEqual(['expected pe arm64 | received: pe x64']);
    expect(
      runtimeHeaderProblems('darwin-arm64', glibcX64([]), { enforceGlibcFloor: true })
    ).toContain('expected macho arm64 | received: elf x64');
  });

  test('a musl target must be static and a gnu target must use the glibc loader', () => {
    expect(
      runtimeHeaderProblems('linux-x64-musl', glibcX64([]), { enforceGlibcFloor: true })
    ).toEqual([
      'expected a static musl executable (no PT_INTERP) | received interpreter: /lib64/ld-linux-x86-64.so.2',
    ]);
    expect(
      runtimeHeaderProblems(
        'linux-x64',
        readExecutableHeader(fakeElf({ arch: 'x64', interpreter: null })),
        { enforceGlibcFloor: true }
      )
    ).toEqual(['expected glibc loader /lib64/ld-linux-x86-64.so.2 | received: none (static)']);
  });

  test('a Windows runtime may not depend on the Visual C++ Redistributable', () => {
    const options = { enforceGlibcFloor: true };
    const dynamicCrt = readExecutableHeader(
      fakePe('arm64', {
        imports: ['KERNEL32.dll', 'VCRUNTIME140.dll', 'api-ms-win-crt-runtime-l1-1-0.dll'],
        delayImports: ['msvcp140_1.dll'],
      })
    );
    expect(runtimeHeaderProblems('windows-arm64', dynamicCrt, options)).toEqual([
      'expected no Visual C++ Redistributable imports (link with +crt-static) | received: VCRUNTIME140.dll, msvcp140_1.dll',
    ]);

    // What a +crt-static build imports: Windows' own DLLs only.
    const staticCrt = readExecutableHeader(
      fakePe('x64', { imports: ['KERNEL32.dll', 'ntdll.dll', 'bcryptprimitives.dll'] })
    );
    expect(runtimeHeaderProblems('windows-x64', staticCrt, options)).toEqual([]);
  });

  test('enforces the glibc floor only when asked', () => {
    const header = glibcX64(['GLIBC_2.17', 'GLIBC_2.34']);
    expect(runtimeHeaderProblems('linux-x64', header, { enforceGlibcFloor: true })).toEqual([
      `expected no symbol newer than GLIBC_${GLIBC_FLOOR} | received: GLIBC_2.34`,
    ]);
    expect(runtimeHeaderProblems('linux-x64', header, { enforceGlibcFloor: false })).toEqual([]);
  });
});

describe('runtime version check', () => {
  test('compares --version output with the release verbatim', () => {
    expect(runtimeVersionProblem('0.0.0-dryrun\n', '0.0.0-dryrun')).toBeNull();
    expect(runtimeVersionProblem('mangostudio-runtime 0.1.1\n', '0.1.1')).toBe(
      'expected --version: 0.1.1 | received: mangostudio-runtime 0.1.1'
    );
    expect(runtimeVersionProblem('', '0.1.1')).toBe(
      'expected --version: 0.1.1 | received: (empty)'
    );
  });

  test('verifyRuntimeBinary reports a file that is not an executable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'runtime-verify-'));
    try {
      const path = join(dir, 'mangostudio-runtime');
      writeFileSync(path, 'not a binary');
      chmodSync(path, 0o755);
      const result = await verifyRuntimeBinary({
        path,
        target: target('linux-x64'),
        version: '0.1.1',
        hostPlatform: 'linux-x64',
        enforceGlibcFloor: true,
      });
      expect(result.header).toBeNull();
      expect(result.problems).toEqual([
        `${path}: expected an executable of at least 64 bytes (ELF, Mach-O, or PE32+) | received: 12 bytes`,
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('verifyRuntimeBinary does not run a binary built for another machine', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'runtime-verify-'));
    try {
      const path = join(dir, 'mangostudio-runtime.exe');
      writeFileSync(path, fakePe('arm64'));
      const result = await verifyRuntimeBinary({
        path,
        target: target('windows-arm64'),
        version: '0.1.1',
        hostPlatform: 'linux-x64',
        enforceGlibcFloor: true,
      });
      expect(result).toEqual({
        header: { format: 'pe', arch: 'arm64', interpreter: null, maxGlibc: null, dllImports: [] },
        reportedVersion: null,
        problems: [],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runtime build wiring', () => {
  test('build-runtime.ts stays dependency-free so CI can run it with --no-install', () => {
    const walk = walkRuntimeImports('scripts/build-runtime.ts');
    expect([...walk.externalSpecifiers.keys()].filter((spec) => !spec.startsWith('node:'))).toEqual(
      []
    );
  });

  test('the binary build no longer compiles the TypeScript runtime', () => {
    const buildScript = readText('scripts/build.ts');
    expect(buildScript).not.toContain('apps/runtime/src/cli.ts');
    expect(buildScript).toContain('resolveRuntimeSource');
  });

  test('exposes the runtime build as a root script', () => {
    const manifest = JSON.parse(readText('package.json')) as { scripts: Record<string, string> };
    expect(manifest.scripts['build:runtime']).toBe('bun ./scripts/build-runtime.ts');
  });
});
