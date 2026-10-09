import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import type { RuntimeSettingsReadFailure } from '../index';

/** Ceiling for one settings source, matching the pre-relocation hub reader. */
export const MAX_SETTINGS_SOURCE_BYTES = 512 * 1024;

export interface SettingsFileStats {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

/** Host filesystem seam for exact entry/descriptor identity and bounded reads. */
export interface SettingsFileSystem {
  lstat(path: string): SettingsFileStats;
  open(path: string, flags: number): number;
  fstat(fd: number): SettingsFileStats;
  read(fd: number, buffer: Buffer, offset: number, length: number, position: number): number;
  close(fd: number): void;
}

const nodeFs: SettingsFileSystem = {
  lstat: (path) => lstatSync(path, { bigint: true }),
  open: openSync,
  fstat: (fd) => fstatSync(fd, { bigint: true }),
  read: readSync,
  close: closeSync,
};

const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/**
 * Reads only after the opened descriptor and the final path entry match the
 * exact regular-file identity observed before open. POSIX O_NOFOLLOW remains
 * in use; Windows' missing flag is covered by the same descriptor checks.
 * O_NONBLOCK prevents a substituted FIFO from blocking open on POSIX hosts.
 * An unavailable inode identity fails closed. This does not refuse hard links
 * or symlinks in ancestor directories, which remain outside the leaf policy.
 * // Usage: readBoundedUtf8('/home/me/.claude/settings.json').content
 */
export function readBoundedUtf8(
  path: string,
  fs: SettingsFileSystem = nodeFs
): { content: string; sizeBytes: number } {
  const expected = fs.lstat(path);
  assertRegularFileIdentity(expected, path);
  const fd = fs.open(path, READ_FLAGS);
  try {
    const stats = fs.fstat(fd);
    assertSameFileIdentity(expected, stats, path);
    assertSameFileIdentity(expected, fs.lstat(path), path);
    const sizeBytes = Number(stats.size);
    if (stats.size > BigInt(MAX_SETTINGS_SOURCE_BYTES)) {
      throw new SettingsReadError(
        'too-large',
        path,
        `size ${stats.size} exceeds the ${MAX_SETTINGS_SOURCE_BYTES}-byte limit`
      );
    }
    if (sizeBytes === 0) return { content: '', sizeBytes };

    const buffer = Buffer.alloc(sizeBytes);
    let offset = 0;
    while (offset < sizeBytes) {
      const bytesRead = fs.read(fd, buffer, offset, sizeBytes - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return { content: buffer.subarray(0, offset).toString('utf8'), sizeBytes };
  } finally {
    fs.close(fd);
  }
}

function assertRegularFileIdentity(stats: SettingsFileStats, path: string): void {
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new SettingsReadError('not-regular-file', path, 'expected a regular final path entry');
  }
  if (
    typeof stats.ino !== 'bigint' ||
    typeof stats.dev !== 'bigint' ||
    stats.ino <= 0n ||
    stats.dev < 0n
  ) {
    throw new SettingsReadError(
      'unreadable',
      path,
      `file identity ${stats.dev}:${stats.ino} is unavailable; expected exact device and inode IDs`
    );
  }
}

function assertSameFileIdentity(
  expected: SettingsFileStats,
  actual: SettingsFileStats,
  path: string
): void {
  assertRegularFileIdentity(actual, path);
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) {
    throw new SettingsReadError(
      'unreadable',
      path,
      `file identity ${actual.dev}:${actual.ino} differs from expected ${expected.dev}:${expected.ino}`
    );
  }
}

/** A refusal whose reason is preserved in the settings-source response. */
export class SettingsReadError extends Error {
  constructor(
    readonly reason: RuntimeSettingsReadFailure,
    path: string,
    detail = 'expected a stable regular file within the settings byte limit'
  ) {
    super(`Cannot read settings source "${path}": ${reason}; ${detail}.`);
    this.name = 'SettingsReadError';
  }
}
