import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { leftoverSocketFiles, SocketTestHome } from './support/socket-address';

const WINDOWS = process.platform === 'win32';
// A pid no test run here owns, so a planted file is never mistaken for a live one.
const FAKE_PID = 999_999_001;

function listenAt(path: string): Promise<ReturnType<typeof createServer>> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(path, () => resolve(server));
  });
}

describe.skipIf(WINDOWS)('SocketTestHome (POSIX socket files)', () => {
  it('hands out short addresses inside a per-run temp directory, not the runtime directory', () => {
    const home = new SocketTestHome('hygiene', { watchedDirectories: [] });
    try {
      const address = home.nextAddress();
      expect(
        address.startsWith(join(tmpdir(), 'mps-')),
        `(address): expected a path under ${join(tmpdir(), 'mps-')}* | received: ${address}`
      ).toBe(true);
      expect(Buffer.byteLength(address)).toBeLessThan(104);
      expect(home.nextAddress()).not.toBe(address);
    } finally {
      home.release();
      home.verifyNoLeftovers();
    }
  });

  it('release removes the file of a listener that was never closed, as a failing case leaves it', async () => {
    const home = new SocketTestHome('hygiene', { watchedDirectories: [] });
    const address = home.nextAddress();
    const server = await listenAt(address);
    try {
      expect(existsSync(address), `(${address}): expected a socket file while listening`).toBe(
        true
      );
      home.release();
      expect(existsSync(address), `(${address}): expected the file removed by release`).toBe(false);
    } finally {
      server.close();
      home.verifyNoLeftovers();
    }
  });

  it('verifyNoLeftovers names a stray socket file of this pid', () => {
    const watched = mkdtempSync(join(tmpdir(), 'mps-watch-'));
    const stray = join(watched, `mango-protocol-test-${FAKE_PID}-7.sock`);
    const home = new SocketTestHome('hygiene', { watchedDirectories: [watched], pid: FAKE_PID });
    try {
      writeFileSync(stray, '');
      expect(() => home.verifyNoLeftovers()).toThrow(
        `(hygiene socket tests): expected no socket files left behind | received 1: ${stray}`
      );
    } finally {
      rmSync(watched, { recursive: true, force: true });
    }
  });

  it('ignores files that were there before and files of other pids', () => {
    const watched = mkdtempSync(join(tmpdir(), 'mps-watch-'));
    try {
      writeFileSync(join(watched, `mango-protocol-test-${FAKE_PID}-1.sock`), '');
      writeFileSync(join(watched, `mango-protocol-test-${FAKE_PID + 1}-1.sock`), '');
      const home = new SocketTestHome('hygiene', { watchedDirectories: [watched], pid: FAKE_PID });
      expect(() => home.verifyNoLeftovers()).not.toThrow();
    } finally {
      rmSync(watched, { recursive: true, force: true });
    }
  });

  it('verifyNoLeftovers names a file left in the run directory', () => {
    const home = new SocketTestHome('hygiene', { watchedDirectories: [] });
    const address = home.nextAddress();
    writeFileSync(address, '');
    expect(() => home.verifyNoLeftovers()).toThrow(`received 1: ${address}`);
    expect(existsSync(address)).toBe(false);
  });
});

describe('leftoverSocketFiles', () => {
  it('returns nothing for a directory that does not exist', () => {
    expect(leftoverSocketFiles([join(tmpdir(), 'mps-no-such-directory')], FAKE_PID)).toEqual([]);
  });
});
