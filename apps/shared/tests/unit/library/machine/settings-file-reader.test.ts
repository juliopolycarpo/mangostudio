import { describe, expect, it } from 'bun:test';
import { constants } from 'node:fs';
import {
  MAX_SETTINGS_SOURCE_BYTES,
  readBoundedUtf8,
  type SettingsFileStats,
  type SettingsFileSystem,
  SettingsReadError,
} from '../../../../src/library/machine/settings-file-reader';

const SETTINGS_PATH = '/machine/.claude/settings.json';
const CONTENT = '{"model":"opus"}';

class FakeFileStats implements SettingsFileStats {
  constructor(
    readonly ino = 9_007_199_254_740_993n,
    readonly dev = 42n,
    readonly size = BigInt(Buffer.byteLength(CONTENT)),
    readonly kind: 'file' | 'directory' | 'symlink' | 'fifo' = 'file'
  ) {}

  isFile() {
    return this.kind === 'file';
  }

  isSymbolicLink() {
    return this.kind === 'symlink';
  }
}

/** Controls entry substitutions without ever opening a live credential file. */
class FakeSettingsFileSystem implements SettingsFileSystem {
  readonly events: string[] = [];
  readonly before: SettingsFileStats;
  readonly descriptor: SettingsFileStats;
  readonly after: SettingsFileStats;
  readonly content: Buffer;
  openFlags: number | undefined;
  private readonly chunkSize: number;
  private lstatCalls = 0;

  constructor(
    options: {
      readonly before?: SettingsFileStats;
      readonly descriptor?: SettingsFileStats;
      readonly after?: SettingsFileStats;
      readonly content?: string;
      readonly chunkSize?: number;
    } = {}
  ) {
    this.before = options.before ?? new FakeFileStats();
    this.descriptor = options.descriptor ?? this.before;
    this.after = options.after ?? this.before;
    this.content = Buffer.from(options.content ?? CONTENT);
    this.chunkSize = options.chunkSize ?? Number.POSITIVE_INFINITY;
  }

  lstat() {
    this.events.push('lstat');
    this.lstatCalls += 1;
    return this.lstatCalls === 1 ? this.before : this.after;
  }

  open(_path: string, flags: number) {
    this.events.push('open');
    this.openFlags = flags;
    return 7;
  }

  fstat() {
    this.events.push('fstat');
    return this.descriptor;
  }

  read(_fd: number, buffer: Buffer, offset: number, length: number, position: number) {
    this.events.push('read');
    const available = Math.max(0, this.content.length - position);
    const count = Math.min(length, this.chunkSize, available);
    this.content.copy(buffer, offset, position, position + count);
    return count;
  }

  close() {
    this.events.push('close');
  }
}

function captureRead(fs: SettingsFileSystem): unknown {
  try {
    return readBoundedUtf8(SETTINGS_PATH, fs);
  } catch (error) {
    return error;
  }
}

describe('readBoundedUtf8', () => {
  it('checks exact entry and descriptor identity before reading bytes', () => {
    const fs = new FakeSettingsFileSystem();

    expect(readBoundedUtf8(SETTINGS_PATH, fs)).toEqual({
      content: CONTENT,
      sizeBytes: Buffer.byteLength(CONTENT),
    });
    expect(fs.events).toEqual(['lstat', 'open', 'fstat', 'lstat', 'read', 'close']);
  });

  it('keeps no-follow and nonblocking open flags where the host supports them', () => {
    const fs = new FakeSettingsFileSystem();

    readBoundedUtf8(SETTINGS_PATH, fs);

    expect(fs.openFlags).toBe(
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
    );
  });

  it.each(['symlink', 'directory'] as const)('refuses a %s before opening it', (kind) => {
    const fs = new FakeSettingsFileSystem({ before: new FakeFileStats(1n, 42n, 4n, kind) });

    const error = captureRead(fs);

    expect(error).toBeInstanceOf(SettingsReadError);
    expect((error as SettingsReadError).reason).toBe('not-regular-file');
    expect(fs.events).toEqual(['lstat']);
  });

  it('rejects a descriptor opened from a substituted symlink before reading target bytes', () => {
    const fs = new FakeSettingsFileSystem({
      descriptor: new FakeFileStats(2n),
      content: '{"token":"stolen"}',
    });

    const error = captureRead(fs);

    expect(error).toBeInstanceOf(SettingsReadError);
    expect((error as SettingsReadError).reason).toBe('unreadable');
    expect(fs.events).not.toContain('read');
    expect(fs.events.at(-1)).toBe('close');
  });

  it('refuses a FIFO descriptor substituted between lstat and open', () => {
    const fs = new FakeSettingsFileSystem({
      descriptor: new FakeFileStats(2n, 42n, 0n, 'fifo'),
    });

    const error = captureRead(fs);

    expect(error).toBeInstanceOf(SettingsReadError);
    expect((error as SettingsReadError).reason).toBe('not-regular-file');
    expect(fs.events).not.toContain('read');
    expect(fs.events.at(-1)).toBe('close');
  });

  it('refuses an entry replaced by a symlink after the descriptor was opened', () => {
    const fs = new FakeSettingsFileSystem({
      after: new FakeFileStats(9_007_199_254_740_993n, 42n, 4n, 'symlink'),
    });

    const error = captureRead(fs);

    expect(error).toBeInstanceOf(SettingsReadError);
    expect((error as SettingsReadError).reason).toBe('not-regular-file');
    expect(fs.events).toEqual(['lstat', 'open', 'fstat', 'lstat', 'close']);
  });

  it('refuses a regular entry replaced after the descriptor was opened', () => {
    const fs = new FakeSettingsFileSystem({ after: new FakeFileStats(2n) });

    const error = captureRead(fs);

    expect(error).toBeInstanceOf(SettingsReadError);
    expect((error as SettingsReadError).reason).toBe('unreadable');
    expect(fs.events).not.toContain('read');
    expect(fs.events.at(-1)).toBe('close');
  });

  it('compares the device as well as the inode', () => {
    const fs = new FakeSettingsFileSystem({
      descriptor: new FakeFileStats(9_007_199_254_740_993n, 43n),
    });

    expect(captureRead(fs)).toBeInstanceOf(SettingsReadError);
    expect(fs.events).not.toContain('read');
    expect(fs.events.at(-1)).toBe('close');
  });

  it('keeps inode differences beyond Number precision exact', () => {
    const inode = 2n ** 60n;
    const fs = new FakeSettingsFileSystem({
      before: new FakeFileStats(inode),
      descriptor: new FakeFileStats(inode + 1n),
    });
    expect(Number(inode)).toBe(Number(inode + 1n));

    expect(captureRead(fs)).toBeInstanceOf(SettingsReadError);
    expect(fs.events).not.toContain('read');
    expect(fs.events.at(-1)).toBe('close');
  });

  it('fails closed when the filesystem provides no inode identity', () => {
    const fs = new FakeSettingsFileSystem({ before: new FakeFileStats(0n) });

    const error = captureRead(fs);

    expect(error).toBeInstanceOf(SettingsReadError);
    expect((error as SettingsReadError).reason).toBe('unreadable');
    expect(fs.events).toEqual(['lstat']);
  });

  it('keeps the byte limit before any buffer allocation or read', () => {
    const fs = new FakeSettingsFileSystem({
      before: new FakeFileStats(1n, 42n, BigInt(MAX_SETTINGS_SOURCE_BYTES) + 1n),
    });

    const error = captureRead(fs);

    expect(error).toBeInstanceOf(SettingsReadError);
    expect((error as SettingsReadError).reason).toBe('too-large');
    expect(fs.events).not.toContain('read');
    expect(fs.events.at(-1)).toBe('close');
  });

  it('reads a stable file over multiple chunks', () => {
    const fs = new FakeSettingsFileSystem({ chunkSize: 3 });

    expect(readBoundedUtf8(SETTINGS_PATH, fs).content).toBe(CONTENT);
    expect(fs.events.filter((event) => event === 'read').length).toBeGreaterThan(1);
    expect(fs.events.at(-1)).toBe('close');
  });

  it('validates even an empty file and closes it without reading', () => {
    const fs = new FakeSettingsFileSystem({ before: new FakeFileStats(1n, 42n, 0n) });

    expect(readBoundedUtf8(SETTINGS_PATH, fs)).toEqual({ content: '', sizeBytes: 0 });
    expect(fs.events).toEqual(['lstat', 'open', 'fstat', 'lstat', 'close']);
  });
});
