import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { compareDottedVersions, readExecutableHeader } from '../lib/executable-header';
import { fakeElf, fakeMachO, fakePe } from './support/executable-fixtures';

describe('readExecutableHeader', () => {
  test('reads a dynamic glibc ELF: CPU, loader, and highest GLIBC version', () => {
    const header = readExecutableHeader(
      fakeElf({
        arch: 'x64',
        interpreter: '/lib64/ld-linux-x86-64.so.2',
        strings: ['GLIBC_2.2.5', 'GLIBC_2.17', 'GLIBC_2.9'],
      })
    );
    expect(header).toEqual({
      format: 'elf',
      arch: 'x64',
      interpreter: '/lib64/ld-linux-x86-64.so.2',
      maxGlibc: '2.17',
      dllImports: [],
    });
  });

  test('reads a static aarch64 ELF as having no interpreter', () => {
    const header = readExecutableHeader(fakeElf({ arch: 'arm64', interpreter: null }));
    expect(header).toEqual({
      format: 'elf',
      arch: 'arm64',
      interpreter: null,
      maxGlibc: null,
      dllImports: [],
    });
  });

  test('reads Mach-O and PE32+ CPUs', () => {
    expect(readExecutableHeader(fakeMachO('arm64'))).toMatchObject({
      format: 'macho',
      arch: 'arm64',
    });
    expect(readExecutableHeader(fakeMachO('x64'))).toMatchObject({ format: 'macho', arch: 'x64' });
    expect(readExecutableHeader(fakePe('arm64'))).toMatchObject({ format: 'pe', arch: 'arm64' });
    expect(readExecutableHeader(fakePe('x64'))).toMatchObject({ format: 'pe', arch: 'x64' });
  });

  test('lists PE imports and delay-load imports by DLL name', () => {
    const header = readExecutableHeader(
      fakePe('x64', {
        imports: ['KERNEL32.dll', 'VCRUNTIME140.dll', 'ws2_32.dll'],
        delayImports: ['MSVCP140.dll'],
      })
    );
    expect(header.dllImports).toEqual([
      'KERNEL32.dll',
      'VCRUNTIME140.dll',
      'ws2_32.dll',
      'MSVCP140.dll',
    ]);
  });

  test('a PE with no import directory imports nothing', () => {
    expect(readExecutableHeader(fakePe('arm64')).dllImports).toEqual([]);
  });

  test('rejects a script with the magic it found', () => {
    const script = new TextEncoder().encode(`#!/bin/sh\n${'echo hi\n'.repeat(10)}`);
    expect(() => readExecutableHeader(script)).toThrow(
      'expected an ELF, Mach-O (64-bit), or PE executable | received magic bytes: 23 21 2f 62'
    );
  });

  test('rejects a 32-bit ELF, a 32-bit PE, and an unknown CPU', () => {
    const elf32 = fakeElf({ arch: 'x64', interpreter: null });
    elf32[4] = 1;
    expect(() => readExecutableHeader(elf32)).toThrow('received: EI_CLASS=1, EI_DATA=1');

    expect(() => readExecutableHeader(fakePe('x64', { pe32: true }))).toThrow(
      'expected a PE32+ optional header (magic 0x20b) | received: 0x10b'
    );

    const riscv = fakeElf({ arch: 'x64', interpreter: null });
    new DataView(riscv.buffer).setUint16(18, 0xf3, true);
    expect(() => readExecutableHeader(riscv)).toThrow('received: 0xf3');
  });

  test('rejects a truncated file with its size', () => {
    expect(() => readExecutableHeader(new Uint8Array(10))).toThrow('received: 10 bytes');
  });

  test('reads the Bun binary running this test as a native executable', () => {
    const header = readExecutableHeader(readFileSync(process.execPath));
    const formats: Record<string, string> = { linux: 'elf', darwin: 'macho', win32: 'pe' };
    expect(`${header.format} ${header.arch}`).toBe(`${formats[process.platform]} ${process.arch}`);
  });
});

describe('compareDottedVersions', () => {
  test('compares numerically, not lexically', () => {
    expect(compareDottedVersions('2.17', '2.9')).toBe(1);
    expect(compareDottedVersions('2.17', '2.17.0')).toBe(0);
    expect(compareDottedVersions('2.2.5', '2.17')).toBe(-1);
  });
});
