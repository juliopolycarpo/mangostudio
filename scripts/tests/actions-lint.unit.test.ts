import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  assertSafeArchiveEntries,
  type BootstrapIo,
  createBootstrapIo,
  ensureTool,
  installTool,
} from '../lib/actions-lint/bootstrap';
import {
  ALL_TOOL_NAMES,
  type PlatformKey,
  resolvePlatformKey,
  TOOL_MANIFEST,
  type ToolManifestEntry,
  toolAssetUrl,
} from '../lib/actions-lint/manifest';
import {
  type ActionsLintDeps,
  createActionlintCommand,
  createActionsLintTasks,
  createShellcheckCommand,
  createZizmorCommand,
  touchesActionsLintSurface,
} from '../lib/actions-lint/run';
import type { CaptureResult } from '../lib/exec';
import { readText } from './support/read-text';

const FAKE_ARCHIVE = new TextEncoder().encode('fake-archive-bytes');
const FAKE_SHA256 = createHash('sha256').update(FAKE_ARCHIVE).digest('hex');
const cacheDirs: string[] = [];

afterEach(async () => {
  for (const dir of cacheDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function fakeEntry(overrides?: Partial<ToolManifestEntry>): ToolManifestEntry {
  const asset = { assetName: 'fake-tool-1.0.0.tar.gz', sha256: FAKE_SHA256 };
  return {
    name: 'actionlint',
    version: '1.0.0',
    baseUrl: 'https://example.invalid/releases/v1.0.0',
    binaryPath: 'fake-tool',
    assets: {
      'linux-x64': asset,
      'linux-arm64': asset,
      'darwin-x64': asset,
      'darwin-arm64': asset,
      'win32-x64': {
        assetName: 'fake-tool-1.0.0.zip',
        sha256: FAKE_SHA256,
        binaryPath: 'fake-tool.exe',
      },
    },
    ...overrides,
  };
}

class FakeBootstrapIo implements BootstrapIo {
  readonly downloads: string[] = [];
  readonly operations: string[] = [];
  bytes: Uint8Array = FAKE_ARCHIVE;
  entries = ['fake-tool'];
  binaryPath = 'fake-tool';
  binaryContent = '#!/bin/sh\n';
  downloadError: Error | null = null;

  download(url: string): Promise<Uint8Array> {
    this.downloads.push(url);
    if (this.downloadError) return Promise.reject(this.downloadError);
    return Promise.resolve(this.bytes);
  }

  listArchiveEntries(): Promise<string[]> {
    this.operations.push('list');
    return Promise.resolve(this.entries);
  }

  extractArchive(_archivePath: string, destDir: string): Promise<void> {
    this.operations.push('extract');
    const path = join(destDir, this.binaryPath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, this.binaryContent);
    return Promise.resolve();
  }
}

class FakePowerShellZipCommands {
  readonly commands: string[][] = [];
  entries = ['fake-tool.exe'];

  run(command: string[]): Promise<CaptureResult> {
    this.commands.push(command);
    const script = command[3] ?? '';
    if (script.includes('OpenRead')) {
      return Promise.resolve({ stdout: this.entries.join('\r\n'), stderr: '', exitCode: 0 });
    }
    const destination = script.match(/-DestinationPath '((?:[^']|'')*)' -Force/)?.[1];
    if (!destination) throw new Error(`Expected a ZIP extraction command, got ${script}`);
    writeFileSync(join(destination.replaceAll("''", "'"), 'fake-tool.exe'), 'Windows binary');
    return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
  }
}

async function tempCacheDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'actions-lint-test-'));
  cacheDirs.push(dir);
  return dir;
}

describe('actions-lint manifest', () => {
  test('pins a verified https release asset for every tool and platform', () => {
    for (const name of ALL_TOOL_NAMES) {
      const entry = TOOL_MANIFEST[name];
      expect(entry.name).toBe(name);
      expect(entry.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(entry.baseUrl).toMatch(
        new RegExp(`^https://github\\.com/[\\w.-]+/[\\w.-]+/releases/download/v${entry.version}$`)
      );
      for (const [platform, asset] of Object.entries(entry.assets)) {
        expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(asset.assetName).not.toContain('/');
        expect(toolAssetUrl(entry, platform as PlatformKey)).toBe(
          `${entry.baseUrl}/${asset.assetName}`
        );
        expect(asset.assetName).toEndWith(platform === 'win32-x64' ? '.zip' : '.tar.gz');
        if (platform === 'win32-x64') expect(asset.binaryPath).toBe(`${name}.exe`);
      }
    }
  });

  test('maps supported platforms and fails actionably on unsupported ones', () => {
    expect(resolvePlatformKey('linux', 'x64')).toBe('linux-x64');
    expect(resolvePlatformKey('darwin', 'arm64')).toBe('darwin-arm64');
    expect(resolvePlatformKey('win32', 'x64')).toBe('win32-x64');
    expect(() => resolvePlatformKey('win32', 'arm64')).toThrow(
      /no pinned binaries for win32\/arm64.*manifest\.ts.*Windows x64/s
    );
  });
});

describe('actions-lint bootstrap', () => {
  test('installs a checksum-verified binary into the cache', async () => {
    const cacheDir = await tempCacheDir();
    const io = new FakeBootstrapIo();

    const binary = await installTool(fakeEntry(), 'linux-x64', cacheDir, io);

    expect(binary).toBe(join(cacheDir, 'actionlint', '1.0.0', 'linux-x64', 'fake-tool'));
    expect(await Bun.file(binary).exists()).toBe(true);
    expect(io.downloads).toEqual([
      'https://example.invalid/releases/v1.0.0/fake-tool-1.0.0.tar.gz',
    ]);
    expect(io.operations).toEqual(['list', 'extract']);
  });

  test('installs the Windows ZIP executable using the asset member override', async () => {
    const cacheDir = await tempCacheDir();
    const commands = new FakePowerShellZipCommands();
    const download = new FakeBootstrapIo();
    const io = createBootstrapIo({
      unzipCommand: null,
      platform: 'win32',
      runCommand: commands.run.bind(commands),
    });
    io.download = download.download.bind(download);

    const binary = await installTool(fakeEntry(), 'win32-x64', cacheDir, io);

    expect(binary).toBe(join(cacheDir, 'actionlint', '1.0.0', 'win32-x64', 'fake-tool.exe'));
    expect(await Bun.file(binary).text()).toBe('Windows binary');
    expect(download.downloads).toEqual([
      'https://example.invalid/releases/v1.0.0/fake-tool-1.0.0.zip',
    ]);
    expect(commands.commands).toHaveLength(3);
    expect(commands.commands.at(-1)?.[3]).toContain('Expand-Archive');
  });

  test('keeps same-version binaries from different platforms in separate caches', async () => {
    const cacheDir = await tempCacheDir();
    const linux = new FakeBootstrapIo();
    linux.binaryContent = 'Linux binary';
    const darwin = new FakeBootstrapIo();
    darwin.binaryContent = 'macOS binary';

    const linuxBinary = await installTool(fakeEntry(), 'linux-x64', cacheDir, linux);
    const darwinBinary = await installTool(fakeEntry(), 'darwin-x64', cacheDir, darwin);

    expect(await Bun.file(linuxBinary).text()).toBe('Linux binary');
    expect(await Bun.file(darwinBinary).text()).toBe('macOS binary');
    expect(linux.downloads).toHaveLength(1);
    expect(darwin.downloads).toHaveLength(1);
  });

  test('does not share an in-flight bootstrap between Windows and Linux', async () => {
    const cacheDir = await tempCacheDir();
    const entry = TOOL_MANIFEST.actionlint;
    const linuxBinary = join(cacheDir, 'actionlint', entry.version, 'linux-x64', 'actionlint');
    const windowsBinary = join(
      cacheDir,
      'actionlint',
      entry.version,
      'win32-x64',
      'actionlint.exe'
    );
    for (const binary of [linuxBinary, windowsBinary]) {
      mkdirSync(dirname(binary), { recursive: true });
      writeFileSync(binary, 'cached');
    }
    const io = new FakeBootstrapIo();
    io.downloadError = new Error('network must not be touched on a cache hit');

    const binaries = await Promise.all([
      ensureTool('actionlint', { cacheDir, platform: 'linux', arch: 'x64', io }),
      ensureTool('actionlint', { cacheDir, platform: 'win32', arch: 'x64', io }),
    ]);

    expect(binaries).toEqual([linuxBinary, windowsBinary]);
    expect(io.downloads).toEqual([]);
  });

  test('returns the cached binary offline without downloading', async () => {
    const cacheDir = await tempCacheDir();
    const cached = join(cacheDir, 'actionlint', '1.0.0', 'linux-x64', 'fake-tool');
    mkdirSync(dirname(cached), { recursive: true });
    writeFileSync(cached, '#!/bin/sh\n');
    const io = new FakeBootstrapIo();
    io.downloadError = new Error('network must not be touched on a cache hit');

    expect(await installTool(fakeEntry(), 'linux-x64', cacheDir, io)).toBe(cached);
  });

  test('rejects a checksum mismatch and installs nothing', async () => {
    const cacheDir = await tempCacheDir();
    const entry = fakeEntry();
    const io = new FakeBootstrapIo();
    io.bytes = new TextEncoder().encode('tampered-bytes');

    await expect(installTool(entry, 'linux-x64', cacheDir, io)).rejects.toThrow(
      /SHA-256 mismatch .*Refusing to install/s
    );
    expect(io.operations).toEqual([]);
    expect(
      await Bun.file(join(cacheDir, 'actionlint', '1.0.0', 'linux-x64', 'fake-tool')).exists()
    ).toBe(false);
  });

  test('checks the ZIP digest before running any archive command', async () => {
    const cacheDir = await tempCacheDir();
    const commands = new FakePowerShellZipCommands();
    const download = new FakeBootstrapIo();
    download.bytes = new TextEncoder().encode('tampered ZIP bytes');
    const io = createBootstrapIo({
      unzipCommand: null,
      platform: 'win32',
      runCommand: commands.run.bind(commands),
    });
    io.download = download.download.bind(download);

    await expect(installTool(fakeEntry(), 'win32-x64', cacheDir, io)).rejects.toThrow(
      /SHA-256 mismatch .*Refusing to install/s
    );
    expect(commands.commands).toEqual([]);
  });

  test('keeps gzipped tar extraction in-process', async () => {
    const cacheDir = await tempCacheDir();
    const archivePath = join(cacheDir, 'fixture.tar.gz');
    await Bun.Archive.write(archivePath, { 'fake-tool': 'tar binary' }, { compress: 'gzip' });
    const commands = new FakePowerShellZipCommands();
    const io = createBootstrapIo({ runCommand: commands.run.bind(commands) });
    const destination = join(cacheDir, 'extracted');

    expect(await io.listArchiveEntries(archivePath)).toEqual(['fake-tool']);
    await io.extractArchive(archivePath, destination);

    expect(await Bun.file(join(destination, 'fake-tool')).text()).toBe('tar binary');
    expect(commands.commands).toEqual([]);
  });

  test('rejects archives with traversal or absolute entry paths', async () => {
    expect(() => assertSafeArchiveEntries(['ok/nested', 'plain'])).not.toThrow();
    for (const path of [
      '../evil',
      'nested/../../evil',
      'nested\\..\\evil',
      '/etc/passwd',
      'C:\\evil',
      'C:/evil',
      'C:evil',
      '\\evil',
      '\\\\server\\share\\evil',
    ]) {
      expect(() => assertSafeArchiveEntries([path])).toThrow(
        `unsafe entry path: ${path}. Expected a relative path`
      );
    }

    const cacheDir = await tempCacheDir();
    const io = new FakeBootstrapIo();
    io.entries = ['../outside-cache'];
    await expect(installTool(fakeEntry(), 'linux-x64', cacheDir, io)).rejects.toThrow(
      /unsafe entry path/
    );
    expect(io.operations).toEqual(['list']);
  });

  test('rejects unsafe ZIP members before PowerShell extraction', async () => {
    const cacheDir = await tempCacheDir();
    const commands = new FakePowerShellZipCommands();
    commands.entries = ['fake-tool.exe', 'nested\\..\\outside-cache'];
    const download = new FakeBootstrapIo();
    const io = createBootstrapIo({
      unzipCommand: null,
      platform: 'win32',
      runCommand: commands.run.bind(commands),
    });
    io.download = download.download.bind(download);

    await expect(installTool(fakeEntry(), 'win32-x64', cacheDir, io)).rejects.toThrow(
      /unsafe entry path: nested\\\.\.\\outside-cache/
    );
    expect(commands.commands).toHaveLength(1);
    expect(commands.commands[0]?.[3]).toContain('OpenRead');
  });

  test('reports the expected Windows member when an archive omits its executable', async () => {
    const cacheDir = await tempCacheDir();
    const io = new FakeBootstrapIo();

    await expect(installTool(fakeEntry(), 'win32-x64', cacheDir, io)).rejects.toThrow(
      'Archive fake-tool-1.0.0.zip did not contain expected binary fake-tool.exe'
    );
  });
});

describe('actions-lint tasks', () => {
  const bins: Record<string, string> = {
    actionlint: '/cache/actionlint',
    zizmor: '/cache/zizmor',
    shellcheck: '/cache/shellcheck',
  };

  function deps(overrides?: Partial<ActionsLintDeps>): ActionsLintDeps & {
    commands: string[][];
  } {
    const commands: string[][] = [];
    return {
      commands,
      ensure: (name) => Promise.resolve(bins[name]),
      run: (label, cmd) => {
        commands.push(cmd);
        return Promise.resolve({ label, exitCode: 0, duration: 0 });
      },
      listShellScripts: () => ['scripts/install/install.sh'],
      ...overrides,
    };
  }

  test('runs actionlint with the pinned ShellCheck, zizmor blocking, ShellCheck with -x', async () => {
    const testDeps = deps();
    const results = await Promise.all(createActionsLintTasks(testDeps).map((task) => task()));

    expect(results.map((r) => `${r.label}:${r.exitCode}`)).toEqual([
      'root:actionlint:0',
      'root:zizmor:0',
      'root:shellcheck:0',
    ]);
    // Tasks run concurrently, so command order is not deterministic.
    expect(testDeps.commands).toHaveLength(3);
    expect(testDeps.commands).toContainEqual(
      createActionlintCommand('/cache/actionlint', '/cache/shellcheck')
    );
    expect(testDeps.commands).toContainEqual(createZizmorCommand('/cache/zizmor'));
    expect(testDeps.commands).toContainEqual(
      createShellcheckCommand('/cache/shellcheck', ['scripts/install/install.sh'])
    );
    expect(createZizmorCommand('/cache/zizmor')).toContain('--no-online-audits');
    expect(createZizmorCommand('/cache/zizmor')).toContain('pedantic');
    expect(createZizmorCommand('/cache/zizmor')).toContain('high');
    // Scoped to the one directory GitHub executes; a bare `.` recurses into
    // nested workflow directories that this repository never runs.
    expect(createZizmorCommand('/cache/zizmor')).toContain('.github');
    expect(createZizmorCommand('/cache/zizmor')).not.toContain('.');
    expect(createShellcheckCommand('/cache/shellcheck', ['a.sh'])).toContain(
      '--source-path=SCRIPTDIR'
    );
  });

  test('propagates a non-zero linter exit code unchanged', async () => {
    const failing = deps({
      run: (label) => Promise.resolve({ label, exitCode: 2, duration: 0 }),
    });
    const results = await Promise.all(createActionsLintTasks(failing).map((task) => task()));
    expect(results.every((r) => r.exitCode === 2)).toBe(true);
  });

  test('reports a bootstrap failure as a failing task instead of throwing', async () => {
    const broken = deps({
      ensure: () => Promise.reject(new Error('unsupported platform')),
    });
    const results = await Promise.all(createActionsLintTasks(broken).map((task) => task()));
    expect(results.map((r) => r.exitCode)).toEqual([1, 1, 1]);
  });

  test('skips the ShellCheck task cleanly when no shell scripts are tracked', async () => {
    const noScripts = deps({ listShellScripts: () => [] });
    const [, , shellcheck] = createActionsLintTasks(noScripts);
    expect((await shellcheck()).exitCode).toBe(0);
    expect(noScripts.commands.filter((cmd) => cmd[0] === '/cache/shellcheck')).toEqual([]);
  });

  test('scoped check runs trigger on workflow, bootstrap, and shell changes only', () => {
    expect(touchesActionsLintSurface(['.github/workflows/ci.yml'])).toBe(true);
    expect(touchesActionsLintSurface(['.github/actions/setup-mango/action.yml'])).toBe(true);
    expect(touchesActionsLintSurface(['scripts/lib/actions-lint/manifest.ts'])).toBe(true);
    expect(touchesActionsLintSurface(['scripts/install/install.sh'])).toBe(true);
    expect(touchesActionsLintSurface(['apps/api/src/app.ts', 'README.md'])).toBe(false);
  });

  test('check.ts wires the workflow analysis lane into full and scoped runs', () => {
    const checkScript = readText('scripts/check.ts');
    expect(checkScript).toContain('createActionsLintTasks');
    expect(checkScript).toContain('touchesActionsLintSurface');
  });
});
