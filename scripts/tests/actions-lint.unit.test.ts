import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  assertSafeArchiveEntries,
  type BootstrapIo,
  installTool,
} from '../lib/actions-lint/bootstrap';
import {
  ALL_TOOL_NAMES,
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
import { readText } from './support/read-text';

const FAKE_ARCHIVE = new TextEncoder().encode('fake-archive-bytes');

function fakeEntry(overrides?: Partial<ToolManifestEntry>): ToolManifestEntry {
  const sha256 = createHash('sha256').update(FAKE_ARCHIVE).digest('hex');
  const asset = { assetName: 'fake-tool-1.0.0.tar.gz', sha256 };
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
    },
    ...overrides,
  };
}

function fakeIo(overrides?: Partial<BootstrapIo>): BootstrapIo & { downloads: string[] } {
  const downloads: string[] = [];
  return {
    downloads,
    download(url: string) {
      downloads.push(url);
      return Promise.resolve(FAKE_ARCHIVE);
    },
    listArchiveEntries() {
      return Promise.resolve(['fake-tool']);
    },
    extractArchive(_archivePath: string, destDir: string) {
      writeFileSync(join(destDir, 'fake-tool'), '#!/bin/sh\n');
      return Promise.resolve();
    },
    ...overrides,
  };
}

function tempCacheDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'actions-lint-test-'));
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
      for (const asset of Object.values(entry.assets)) {
        expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(asset.assetName).not.toContain('/');
        expect(toolAssetUrl(entry, 'linux-x64')).toStartWith('https://');
        // Bootstrap reads archives with Bun.Archive, which handles gzipped tar
        // only. Pinning an .xz or .zip asset would fail at extraction time with
        // an opaque "Unrecognized archive format".
        expect(asset.assetName).toEndWith('.tar.gz');
      }
    }
  });

  test('maps supported platforms and fails actionably on unsupported ones', () => {
    expect(resolvePlatformKey('linux', 'x64')).toBe('linux-x64');
    expect(resolvePlatformKey('darwin', 'arm64')).toBe('darwin-arm64');
    expect(() => resolvePlatformKey('win32', 'x64')).toThrow(
      /no pinned binaries for win32\/x64.*manifest\.ts/s
    );
  });
});

describe('actions-lint bootstrap', () => {
  test('installs a checksum-verified binary into the cache', async () => {
    const cacheDir = await tempCacheDir();
    const io = fakeIo();

    const binary = await installTool(fakeEntry(), 'linux-x64', cacheDir, io);

    expect(binary).toBe(join(cacheDir, 'actionlint', '1.0.0', 'fake-tool'));
    expect(await Bun.file(binary).exists()).toBe(true);
    expect(io.downloads).toEqual([
      'https://example.invalid/releases/v1.0.0/fake-tool-1.0.0.tar.gz',
    ]);
  });

  test('returns the cached binary offline without downloading', async () => {
    const cacheDir = await tempCacheDir();
    const cached = join(cacheDir, 'actionlint', '1.0.0', 'fake-tool');
    mkdirSync(dirname(cached), { recursive: true });
    writeFileSync(cached, '#!/bin/sh\n');
    const io = fakeIo({
      download() {
        throw new Error('network must not be touched on a cache hit');
      },
    });

    expect(await installTool(fakeEntry(), 'linux-x64', cacheDir, io)).toBe(cached);
  });

  test('rejects a checksum mismatch and installs nothing', async () => {
    const cacheDir = await tempCacheDir();
    const entry = fakeEntry();
    const io = fakeIo({
      download: () => Promise.resolve(new TextEncoder().encode('tampered-bytes')),
    });

    await expect(installTool(entry, 'linux-x64', cacheDir, io)).rejects.toThrow(
      /SHA-256 mismatch .*Refusing to install/s
    );
    expect(await Bun.file(join(cacheDir, 'actionlint', '1.0.0', 'fake-tool')).exists()).toBe(false);
  });

  test('rejects archives with traversal or absolute entry paths', async () => {
    expect(() => assertSafeArchiveEntries(['ok/nested', 'plain'])).not.toThrow();
    for (const entries of [['../evil'], ['nested/../../evil'], ['/etc/passwd'], ['C:\\evil']]) {
      expect(() => assertSafeArchiveEntries(entries)).toThrow(/unsafe entry path/);
    }

    const cacheDir = await tempCacheDir();
    const io = fakeIo({
      listArchiveEntries: () => Promise.resolve(['../outside-cache']),
    });
    await expect(installTool(fakeEntry(), 'linux-x64', cacheDir, io)).rejects.toThrow(
      /unsafe entry path/
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
