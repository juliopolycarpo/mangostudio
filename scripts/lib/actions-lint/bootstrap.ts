// Verified bootstrap for the pinned workflow static-analysis binaries.
// Downloads a release archive, checks its SHA-256 against the manifest,
// rejects unsafe archive entries, and installs the executable under the
// ignored `.mango/artifacts/tools/` cache. Nothing unverified is ever
// executed, and a populated cache works fully offline.

import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';

import { ROOT_DIR } from '../config';
import { captureCommand } from '../exec';
import {
  type PlatformKey,
  resolvePlatformKey,
  TOOL_MANIFEST,
  type ToolManifestEntry,
  type ToolName,
  toolAssetUrl,
} from './manifest';

const TOOL_CACHE_DIR = join(ROOT_DIR, '.mango', 'artifacts', 'tools');

/** Injectable I/O surface so unit tests never touch the network or tar. */
export interface BootstrapIo {
  download(url: string): Promise<Uint8Array>;
  listArchiveEntries(archivePath: string): Promise<string[]>;
  extractArchive(archivePath: string, destDir: string): Promise<void>;
}

const defaultBootstrapIo: BootstrapIo = {
  async download(url) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Download failed (${response.status} ${response.statusText}): ${url}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  },
  async listArchiveEntries(archivePath) {
    const { stdout, stderr, exitCode } = await captureCommand(['tar', '-tzf', archivePath]);
    if (exitCode !== 0) {
      throw new Error(`Failed to list archive ${archivePath}: ${stderr.trim()}`);
    }
    return stdout.split('\n').filter(Boolean);
  },
  async extractArchive(archivePath, destDir) {
    const { stderr, exitCode } = await captureCommand(['tar', '-xzf', archivePath, '-C', destDir]);
    if (exitCode !== 0) {
      throw new Error(`Failed to extract archive ${archivePath}: ${stderr.trim()}`);
    }
  },
};

export interface BootstrapOptions {
  cacheDir?: string;
  platform?: string;
  arch?: string;
  io?: BootstrapIo;
}

/** Reject entries that would escape the extraction directory. */
export function assertSafeArchiveEntries(entries: string[]): void {
  for (const entry of entries) {
    const unsafe =
      isAbsolute(entry) || /^[a-zA-Z]:[\\/]/.test(entry) || entry.split(/[\\/]/).includes('..');
    if (unsafe) {
      throw new Error(`Refusing to extract archive with unsafe entry path: ${entry}`);
    }
  }
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Cache location of a tool's extracted install directory. */
function toolInstallDir(cacheDir: string, entry: ToolManifestEntry): string {
  return join(cacheDir, entry.name, entry.version);
}

const inflight = new Map<string, Promise<string>>();

/**
 * Return the absolute path of a verified, executable tool binary, downloading
 * and installing it on first use. Concurrent callers share one bootstrap.
 * // Usage: const actionlint = await ensureTool('actionlint');
 */
export function ensureTool(name: ToolName, options: BootstrapOptions = {}): Promise<string> {
  const cacheDir = options.cacheDir ?? TOOL_CACHE_DIR;
  const key = `${name}:${cacheDir}`;
  const pending = inflight.get(key);
  if (pending) return pending;

  const entry = TOOL_MANIFEST[name];
  const platform = resolvePlatformKey(options.platform, options.arch);
  const io = options.io ?? defaultBootstrapIo;
  const task = installTool(entry, platform, cacheDir, io).finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, task);
  return task;
}

/** Verified download → checksum → safe-extract → cache pipeline for one tool. */
export async function installTool(
  entry: ToolManifestEntry,
  platform: PlatformKey,
  cacheDir: string,
  io: BootstrapIo
): Promise<string> {
  const installDir = toolInstallDir(cacheDir, entry);
  const binaryPath = join(installDir, entry.binaryPath);
  if (await Bun.file(binaryPath).exists()) {
    return binaryPath;
  }

  const asset = entry.assets[platform];
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

    const extractedBinary = join(extractDir, entry.binaryPath);
    if (!(await Bun.file(extractedBinary).exists())) {
      throw new Error(
        `Archive ${asset.assetName} did not contain expected binary ${entry.binaryPath}`
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
