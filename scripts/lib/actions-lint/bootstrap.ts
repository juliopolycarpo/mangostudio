// Verified bootstrap for the pinned workflow static-analysis binaries.
// Downloads a release archive, checks its SHA-256 against the manifest,
// rejects unsafe archive entries, and installs the executable under the
// ignored `.mango/artifacts/tools/` cache. Nothing unverified is ever
// executed, and a populated cache works fully offline.

import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, win32 } from 'node:path';

import { extractTarArchive, openTarArchive } from '../archive';
import { ROOT_DIR } from '../config';
import {
  extractZipArchive,
  openZipArchive,
  resolveZipArchiveTool,
  type ZipArchiveDependencies,
} from '../zip-archive';
import {
  type PlatformKey,
  resolvePlatformKey,
  TOOL_MANIFEST,
  type ToolManifestEntry,
  type ToolName,
  toolAssetUrl,
} from './manifest';

const TOOL_CACHE_DIR = join(ROOT_DIR, '.mango', 'artifacts', 'tools');

/**
 * Injectable download and archive I/O. The default implementation reads tar
 * archives with Bun.Archive and ZIP archives with unzip or PowerShell.
 */
export interface BootstrapIo {
  download(url: string): Promise<Uint8Array>;
  listArchiveEntries(archivePath: string): Promise<string[]>;
  extractArchive(archivePath: string, destDir: string): Promise<void>;
}

/**
 * Build archive I/O with injectable ZIP commands for hosts without unzip.
 * // Usage: const io = createBootstrapIo({ unzipCommand: null, platform: 'win32' });
 */
export function createBootstrapIo(zipDependencies: ZipArchiveDependencies = {}): BootstrapIo {
  // Chosen on the first ZIP and kept: the listing `installTool` judges and the extraction that
  // follows it are separate calls, and must not resolve different tools.
  let pinned: ZipArchiveDependencies | undefined;
  const zipTool = (): ZipArchiveDependencies => {
    pinned ??= resolveZipArchiveTool(zipDependencies);
    return pinned;
  };
  return {
    async download(url) {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Download failed (${response.status} ${response.statusText}): ${url}`);
      }
      return new Uint8Array(await response.arrayBuffer());
    },
    async listArchiveEntries(archivePath) {
      const archive = archivePath.endsWith('.zip')
        ? await openZipArchive(archivePath, zipTool())
        : await openTarArchive(archivePath);
      return [...archive.entries];
    },
    async extractArchive(archivePath, destDir) {
      if (archivePath.endsWith('.zip')) {
        // `installTool` already listed and judged the entries; listing again is a second process.
        await extractZipArchive(archivePath, destDir, zipTool());
        return;
      }
      await extractTarArchive(archivePath, destDir);
    },
  };
}

const defaultBootstrapIo = createBootstrapIo();

export interface BootstrapOptions {
  cacheDir?: string;
  platform?: string;
  arch?: string;
  io?: BootstrapIo;
}

/**
 * Reject entries that would escape extraction on either POSIX or Windows.
 * // Usage: assertSafeArchiveEntries(['actionlint.exe', 'LICENSE.txt']);
 */
export function assertSafeArchiveEntries(entries: string[]): void {
  for (const entry of entries) {
    const unsafe =
      isAbsolute(entry) ||
      win32.isAbsolute(entry) ||
      /^[a-zA-Z]:/.test(entry) ||
      entry.split(/[\\/]/).includes('..');
    if (unsafe) {
      throw new Error(
        `Refusing to extract archive with unsafe entry path: ${entry}. ` +
          `Expected a relative path without a drive prefix or '..' segments.`
      );
    }
  }
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Cache location of a tool's extracted install directory. */
function toolInstallDir(cacheDir: string, entry: ToolManifestEntry, platform: PlatformKey): string {
  return join(cacheDir, entry.name, entry.version, platform);
}

const inflight = new Map<string, Promise<string>>();

/**
 * Return the absolute path of a verified, executable tool binary, downloading
 * and installing it on first use. Concurrent callers share one bootstrap.
 * // Usage: const actionlint = await ensureTool('actionlint');
 */
export function ensureTool(name: ToolName, options: BootstrapOptions = {}): Promise<string> {
  const cacheDir = options.cacheDir ?? TOOL_CACHE_DIR;
  const platform = resolvePlatformKey(options.platform, options.arch);
  const key = `${name}:${platform}:${cacheDir}`;
  const pending = inflight.get(key);
  if (pending) return pending;

  const entry = TOOL_MANIFEST[name];
  const io = options.io ?? defaultBootstrapIo;
  const task = installTool(entry, platform, cacheDir, io).finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, task);
  return task;
}

/**
 * Download, verify, safely extract, and cache one tool for the requested platform.
 * // Usage: await installTool(TOOL_MANIFEST.actionlint, 'win32-x64', cacheDir, io);
 */
export async function installTool(
  entry: ToolManifestEntry,
  platform: PlatformKey,
  cacheDir: string,
  io: BootstrapIo
): Promise<string> {
  const asset = entry.assets[platform];
  const archiveBinaryPath = asset.binaryPath ?? entry.binaryPath;
  const installDir = toolInstallDir(cacheDir, entry, platform);
  const binaryPath = join(installDir, archiveBinaryPath);
  if (await Bun.file(binaryPath).exists()) {
    return binaryPath;
  }

  const url = toolAssetUrl(entry, platform);
  const bytes = await io.download(url);

  const actual = sha256Hex(bytes);
  if (actual !== asset.sha256) {
    throw new Error(
      `SHA-256 mismatch for ${asset.assetName}: expected ${asset.sha256}, got ${actual}. ` +
        `Refusing to install ${entry.name}@${entry.version}.`
    );
  }

  await mkdir(cacheDir, { recursive: true });
  const stagingDir = await mkdtemp(join(cacheDir, `.${entry.name}-`));
  try {
    const archivePath = join(stagingDir, asset.assetName);
    await Bun.write(archivePath, bytes);

    assertSafeArchiveEntries(await io.listArchiveEntries(archivePath));

    const extractDir = join(stagingDir, 'extracted');
    await mkdir(extractDir, { recursive: true });
    await io.extractArchive(archivePath, extractDir);

    const extractedBinary = join(extractDir, archiveBinaryPath);
    if (!(await Bun.file(extractedBinary).exists())) {
      throw new Error(
        `Archive ${asset.assetName} did not contain expected binary ${archiveBinaryPath}`
      );
    }
    await chmod(extractedBinary, 0o755);

    await mkdir(dirname(installDir), { recursive: true });
    try {
      await rename(extractDir, installDir);
    } catch {
      // Lost an install race with another process; the winner's copy is
      // equally verified, so fall through to the existence check below.
    }
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }

  if (!(await Bun.file(binaryPath).exists())) {
    throw new Error(`Bootstrap of ${entry.name}@${entry.version} left no binary at ${binaryPath}`);
  }
  return binaryPath;
}
