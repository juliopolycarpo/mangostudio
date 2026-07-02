import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { CURSOR_NATIVE_PACKAGES as SHARED_CURSOR_NATIVE_PACKAGES } from '@mangostudio/shared/catalog';

import {
  assembleCursorSidecar,
  CURSOR_NATIVE_PACKAGES,
  collectCursorSdkChunks,
  createCursorSdkInstallCommand,
  cursorNativePackageFor,
  cursorSdkPackageTreeErrors,
  cursorSidecarPackageTreeErrors,
  normalizeCursorSdkVersion,
} from '../lib/cursor-sidecar';
import { ALL_BINARY_TARGETS, type BinaryTarget } from '../lib/release-targets';
import { readText } from './support/read-text';

function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      files.push(...collectSourceFiles(path));
      continue;
    }
    files.push(path);
  }

  return files;
}

function toPosixPath(path: string): string {
  return path.split(sep).join('/');
}

function linuxX64Target(): BinaryTarget {
  const target = ALL_BINARY_TARGETS.find((candidate) => candidate.arch === 'linux-x64');
  if (!target) throw new Error('linux-x64 target fixture not found');
  return target;
}

function writeFakeSdkPackage(nodeModulesDir: string, options: { cjsChunk?: boolean } = {}): void {
  const shouldWriteCjsChunk = options.cjsChunk ?? true;
  const sdkDir = join(nodeModulesDir, '@cursor', 'sdk');
  mkdirSync(join(sdkDir, 'dist', 'cjs'), { recursive: true });
  mkdirSync(join(sdkDir, 'dist', 'esm'), { recursive: true });
  writeFileSync(join(sdkDir, 'package.json'), JSON.stringify({ name: '@cursor/sdk' }));
  if (shouldWriteCjsChunk) {
    writeFileSync(join(sdkDir, 'dist', 'cjs', '642.js'), '');
  }
  writeFileSync(join(sdkDir, 'dist', 'esm', '642.js'), '');
}

function writeFakeNativePackage(nodeModulesDir: string, packageName: string): void {
  const packageDir = join(nodeModulesDir, packageName);
  mkdirSync(join(packageDir, 'bin'), { recursive: true });
  writeFileSync(
    join(packageDir, 'package.json'),
    JSON.stringify({ name: packageName, bin: { rg: 'bin/rg' } })
  );
  writeFileSync(join(packageDir, 'bin', 'rg'), 'rg');
}

async function runCursorSidecarProtocol(request: Record<string, unknown>): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: Array<Record<string, unknown>>;
  stderr: string;
}> {
  const tempDir = mkdtempSync(join(tmpdir(), 'mangostudio-cursor-sidecar-'));

  try {
    const sidecarPath = join(tempDir, 'run-agent.mjs');
    writeFileSync(
      sidecarPath,
      readText('apps/api/src/services/providers/cursor/sidecar/run-agent.mjs')
    );

    const sdkDir = join(tempDir, 'node_modules', '@cursor', 'sdk');
    mkdirSync(sdkDir, { recursive: true });
    writeFileSync(
      join(sdkDir, 'package.json'),
      JSON.stringify({ type: 'module', exports: './index.js' })
    );
    writeFileSync(
      join(sdkDir, 'index.js'),
      [
        'export class Agent {};',
        'export const Cursor = {',
        '  models: {',
        '    list: async ({ apiKey }) => {',
        "      if (apiKey === 'cursor-bad-key') {",
        "        const error = new Error('Cursor API key rejected');",
        '        error.status = 401;',
        '        error.isRetryable = false;',
        '        throw error;',
        '      }',
        "      return [{ id: 'composer-2.5', parameters: [{ id: 'thinking', values: [{ value: 'high' }] }] }];",
        '    },',
        '  },',
        '};',
      ].join('\n')
    );

    const child = spawn('node', [sidecarPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH ?? '' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.stdin.end(`${JSON.stringify(request)}\n`);

    const status = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code, signal }));
      }
    );

    return {
      ...status,
      stdout: stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
      stderr,
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

describe('cursor sidecar native package mapping', () => {
  test('uses the shared native package map', () => {
    expect(CURSOR_NATIVE_PACKAGES).toBe(SHARED_CURSOR_NATIVE_PACKAGES);
  });

  test('every release target resolves to a package name or an explicit null', () => {
    for (const target of ALL_BINARY_TARGETS) {
      const pkg = cursorNativePackageFor(target);
      expect(pkg === null || pkg.startsWith('@cursor/sdk-')).toBe(true);
    }
  });

  test('maps supported platforms to their Cursor native package', () => {
    const byArch = Object.fromEntries(
      ALL_BINARY_TARGETS.map((target) => [target.arch, cursorNativePackageFor(target)])
    );

    expect(byArch['linux-x64']).toBe('@cursor/sdk-linux-x64');
    expect(byArch['linux-arm64']).toBe('@cursor/sdk-linux-arm64');
    expect(byArch['darwin-x64']).toBe('@cursor/sdk-darwin-x64');
    expect(byArch['darwin-arm64']).toBe('@cursor/sdk-darwin-arm64');
    expect(byArch['windows-x64']).toBe('@cursor/sdk-win32-x64');
  });

  test('musl targets skip the Cursor sidecar', () => {
    const byArch = Object.fromEntries(
      ALL_BINARY_TARGETS.map((target) => [target.arch, cursorNativePackageFor(target)])
    );

    expect(byArch['linux-x64-musl']).toBeNull();
    expect(byArch['linux-arm64-musl']).toBeNull();
  });

  test('platforms without a Cursor runtime are skipped', () => {
    const winArm = ALL_BINARY_TARGETS.find((target) => target.arch === 'windows-arm64');
    expect(winArm).toBeDefined();
    if (winArm) expect(cursorNativePackageFor(winArm)).toBeNull();
  });
});

describe('cursor sidecar SDK staging', () => {
  test('installs all optional native packages through Bun', () => {
    expect(createCursorSdkInstallCommand('1.2.3')).toEqual([
      'bun',
      'install',
      '--no-save',
      '--ignore-scripts',
      '--os=*',
      '--cpu=*',
      '@cursor/sdk@1.2.3',
    ]);
  });

  test('normalizes manifest ranges to exact Cursor SDK versions', () => {
    expect(normalizeCursorSdkVersion('^1.0.22')).toBe('1.0.22');
    expect(normalizeCursorSdkVersion('~1.0.22-beta.1')).toBe('1.0.22-beta.1');
    expect(normalizeCursorSdkVersion('v1.0.22')).toBe('1.0.22');
  });

  test('rejects non-version Cursor SDK specs before package manager execution', () => {
    expect(() => normalizeCursorSdkVersion('latest')).toThrow(
      'Unsupported @cursor/sdk version spec'
    );
    expect(() => normalizeCursorSdkVersion('file:../cursor-sdk')).toThrow(
      'Unsupported @cursor/sdk version spec'
    );
  });

  test('accepts a complete staged SDK and native package tree', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'mangostudio-cursor-sidecar-tree-'));

    try {
      const sidecarDir = join(tempDir, 'cursor-sidecar');
      const nodeModulesDir = join(sidecarDir, 'node_modules');
      const nativePackage = cursorNativePackageFor(linuxX64Target());
      expect(nativePackage).toBe('@cursor/sdk-linux-x64');
      if (!nativePackage) return;

      writeFakeSdkPackage(nodeModulesDir);
      writeFakeNativePackage(nodeModulesDir, nativePackage);

      expect(
        cursorSidecarPackageTreeErrors(
          sidecarDir,
          nativePackage,
          collectCursorSdkChunks(join(nodeModulesDir, '@cursor', 'sdk'))
        )
      ).toEqual([]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('rejects staged SDK trees missing dynamic chunks', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'mangostudio-cursor-sidecar-tree-'));

    try {
      const nodeModulesDir = join(tempDir, 'node_modules');
      writeFakeSdkPackage(nodeModulesDir, { cjsChunk: false });

      expect(cursorSdkPackageTreeErrors(nodeModulesDir).join('\n')).toContain(
        'Missing Cursor SDK cjs numbered chunks'
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('assembles sidecars with the staged dynamic chunk set', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'mangostudio-cursor-sidecar-assemble-'));

    try {
      const nodeModulesDir = join(tempDir, 'node_modules');
      const nativePackage = cursorNativePackageFor(linuxX64Target());
      expect(nativePackage).toBe('@cursor/sdk-linux-x64');
      if (!nativePackage) return;

      writeFakeSdkPackage(nodeModulesDir);
      writeFakeNativePackage(nodeModulesDir, nativePackage);

      const destSidecarDir = join(tempDir, 'dest', 'cursor-sidecar');
      expect(
        assembleCursorSidecar(destSidecarDir, linuxX64Target(), {
          jsClosureDir: nodeModulesDir,
          nativePackagesDir: nodeModulesDir,
          sdkChunks: collectCursorSdkChunks(join(nodeModulesDir, '@cursor', 'sdk')),
          version: '1.0.22',
          cleanup: () => undefined,
        })
      ).toBe(true);
      expect(
        existsSync(join(destSidecarDir, 'node_modules', '@cursor', 'sdk', 'dist', 'cjs', '642.js'))
      ).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('avoids in-process registry tarball downloads', () => {
    const source = readText('scripts/lib/cursor-sidecar.ts');

    expect(source).not.toContain('await fetch(');
    expect(source).not.toContain('arrayBuffer()');
    expect(source).not.toContain("['tar', '-xzf'");
  });

  test('uses Node 22-compatible disposal and no hard-coded tool RPC timeout', () => {
    const source = readText('apps/api/src/services/providers/cursor/sidecar/run-agent.mjs');

    expect(source).not.toContain('await using');
    expect(source).not.toContain('TOOL_RPC_TIMEOUT_MS');
    expect(source).toContain('disposeAgent');
  });

  test('keeps Cursor SDK imports inside the Node sidecar boundary', () => {
    const offenders = collectSourceFiles('apps/api/src')
      .filter((path) => /\.(?:[cm]?[jt]sx?)$/.test(path))
      .filter((path) => !toPosixPath(path).includes('/services/providers/cursor/sidecar/'))
      .filter((path) => readText(path).includes('@cursor/sdk'));

    expect(offenders).toEqual([]);
  });

  test('handles model listing and API key validation protocol requests', async () => {
    const list = await runCursorSidecarProtocol({
      type: 'list_models',
      apiKey: 'cursor-good-key',
    });
    expect(list.code).toBe(0);
    expect(list.stderr).toBe('');
    expect(list.stdout).toEqual([
      {
        type: 'models',
        models: [
          {
            id: 'composer-2.5',
            parameters: [{ id: 'thinking', values: [{ value: 'high' }] }],
          },
        ],
      },
    ]);

    const validation = await runCursorSidecarProtocol({
      type: 'validate_api_key',
      apiKey: 'cursor-good-key',
    });
    expect(validation.code).toBe(0);
    expect(validation.stderr).toBe('');
    expect(validation.stdout).toEqual([{ type: 'ok' }]);
  });

  test('serializes sidecar protocol errors with status and retryability', async () => {
    const result = await runCursorSidecarProtocol({
      type: 'list_models',
      apiKey: 'cursor-bad-key',
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toBe('');
    expect(result.stdout).toEqual([
      {
        type: 'error',
        message: 'Cursor API key rejected',
        content: 'Cursor API key rejected',
        status: 401,
        isRetryable: false,
        retryable: false,
        done: true,
      },
    ]);
  });
});
