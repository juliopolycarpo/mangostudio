import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, lstatSync } from 'node:fs';
import { mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import {
  createManagedProcessFixture,
  type ManagedProcessFixture,
} from '../../support/fixtures/managed-process';

const fixtures: ManagedProcessFixture[] = [];
const extraDirectories: string[] = [];

async function createFixture(
  options: Partial<Parameters<typeof createManagedProcessFixture>[0]> = {}
): Promise<ManagedProcessFixture> {
  const fixture = await createManagedProcessFixture({
    tempPrefix: 'mango-managed-process-',
    ...options,
  });
  fixtures.push(fixture);
  return fixture;
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    if (fixture.child?.exitCode === null && fixture.child.signalCode === null) {
      await fixture.stop('SIGKILL');
    }
    // Some cases deliberately retain a failed cleanup promise/root. The test
    // owns their final disposal independently of the code under test.
    await rm(fixture.tempDir, { force: true, recursive: true });
    await fixture.assertReleased();
  }
  for (const directory of extraDirectories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

describe('createManagedProcessFixture', () => {
  it('counts a child ended by a signal as released', async () => {
    const fixture = await createFixture();
    fixture.spawn({
      cmd: [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
      env: process.env as Record<string, string>,
    });

    await fixture.stop('SIGKILL');
    await fixture.cleanup();

    // A signalled child reports no exit code; that alone must not read as still running.
    await expect(fixture.assertReleased()).resolves.toBeUndefined();
  });

  it('shares cleanup until the child exit and output capture have completed', async () => {
    const fixture = await createFixture();
    fixture.spawn({ cmd: [process.execPath, '-e', 'setInterval(() => {}, 1000)'] });
    const waiting = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const waitForExit = fixture.waitForExit.bind(fixture);
    fixture.waitForExit = async () => {
      waiting.resolve();
      await release.promise;
      return waitForExit();
    };

    const first = fixture.cleanup();
    const second = fixture.cleanup();
    let settled = false;
    const completed = Promise.all([first, second]).then(() => {
      settled = true;
    });
    try {
      await waiting.promise;
      expect(second).toBe(first);
      expect(settled).toBe(false);
      expect(existsSync(fixture.tempDir)).toBe(true);
    } finally {
      release.resolve();
      await completed;
    }
    expect(fixture.cleanup()).toBe(first);
    await fixture.assertReleased();
  });

  it('shares cleanup while storage removal is pending and rejects spawning after cleanup starts', async () => {
    const removing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const fixture = await createFixture({
      removeTempDir: async (path) => {
        removing.resolve();
        await release.promise;
        await rm(path, { force: true, recursive: true });
      },
    });

    const first = fixture.cleanup();
    const second = fixture.cleanup();
    let settled = false;
    const completed = Promise.all([first, second]).then(() => {
      settled = true;
    });
    try {
      await removing.promise;
      expect(second).toBe(first);
      expect(settled).toBe(false);
      expect(() => fixture.spawn({ cmd: [process.execPath, '-e', ''] })).toThrow(
        'cleanup has started'
      );
    } finally {
      release.resolve();
      await completed;
    }
    expect(() => fixture.spawn({ cmd: [process.execPath, '-e', ''] })).toThrow(
      'cleanup has started'
    );
    await fixture.assertReleased();
  });

  it('shares removal failures with concurrent and later callers without retrying', async () => {
    const removal = Promise.withResolvers<void>();
    const denied = Object.assign(new Error('removal denied'), { code: 'EACCES' });
    let calls = 0;
    const fixture = await createFixture({
      removeTempDir: () => {
        calls += 1;
        return removal.promise;
      },
    });

    const first = fixture.cleanup();
    const second = fixture.cleanup();
    const results = Promise.allSettled([first, second]);
    removal.reject(denied);
    const [a, b] = await results;
    if (a?.status !== 'rejected' || b?.status !== 'rejected') {
      throw new Error('Expected both cleanup callers to reject.');
    }
    expect(a.reason).toBe(b.reason);
    expect(a.reason.cause).toBe(denied);
    expect(fixture.cleanup()).toBe(first);
    await expect(fixture.cleanup()).rejects.toThrow('removal denied');
    expect(calls).toBe(1);
    expect(existsSync(fixture.tempDir)).toBe(true);
  });

  it('rejects a remover that resolves with the same empty root still present', async () => {
    const fixture = await createFixture({
      removeTempDir: async () => {
        // Models recursive rm resolving while leaving an empty root.
      },
    });
    const identity = lstatSync(fixture.tempDir, { bigint: true });
    const cleanup = fixture.cleanup();
    await expect(cleanup).rejects.toThrow('Fixture temp directory still exists');
    await expect(cleanup).rejects.toThrow(`dev=${identity.dev} ino=${identity.ino}`);
    await expect(cleanup).rejects.toThrow('same dev/inode as allocated');
    await expect(cleanup).rejects.toThrow('residual paths:\n<empty>');
    expect(existsSync(fixture.tempDir)).toBe(true);
  });

  it('diagnoses a replaced root without deleting it', async () => {
    const fixture = await createFixture({
      removeTempDir: async (path) => {
        const preserved = `${path}-preserved`;
        extraDirectories.push(preserved);
        // Holding the allocated inode elsewhere rules out immediate inode reuse.
        await rename(path, preserved);
        await mkdir(path);
        await writeFile(join(path, 'recreated'), 'do not print file contents');
      },
    });
    const cleanup = fixture.cleanup();
    await expect(cleanup).rejects.toThrow('different dev/inode from allocated (replaced)');
    await expect(cleanup).rejects.toThrow('"recreated"');
    expect(existsSync(join(fixture.tempDir, 'recreated'))).toBe(true);
  });

  it('reports bounded residual paths without reading their contents', async () => {
    const fixture = await createFixture({
      removeTempDir: async () => {
        // Models a remover returning without releasing storage.
      },
    });
    await mkdir(join(fixture.tempDir, '.mango', 'run'), { recursive: true });
    await writeFile(join(fixture.tempDir, '.mango', 'run', 'server.json'), 'private contents');
    const failure = await fixture.cleanup().catch((error: Error) => error);
    expect(String(failure)).toContain(join('.mango', 'run', 'server.json'));
    expect(String(failure)).not.toContain('private contents');

    for (let index = 0; index < 40; index += 1) {
      await writeFile(join(fixture.tempDir, `residue-${index}`), '');
    }
    await expect(fixture.assertReleased()).rejects.toThrow('<path limit reached>');
  });

  it.skipIf(process.platform === 'win32')(
    'rejects a symlink replacing the root without following it',
    async () => {
      const fixture = await createFixture({
        removeTempDir: async (path) => {
          const preserved = `${path}-preserved`;
          extraDirectories.push(preserved);
          await rename(path, preserved);
          await writeFile(join(preserved, 'outside-root'), '');
          await symlink(preserved, path);
        },
      });
      const failure = await fixture.cleanup().catch((error: Error) => error);
      expect(String(failure)).toContain('Fixture temp directory still exists');
      expect(String(failure)).toContain('root is not a directory');
      expect(String(failure)).not.toContain('outside-root');
    }
  );

  it('still detects a directory recreated after successful cleanup', async () => {
    const fixture = await createFixture();
    await fixture.cleanup();
    await mkdir(fixture.tempDir);
    await expect(fixture.assertReleased()).rejects.toThrow('Fixture temp directory still exists');
  });

  it.skipIf(process.platform !== 'linux')(
    'records descendants observed before the child exits',
    async () => {
      const fixture = await createFixture({
        removeTempDir: async () => {
          // Retain storage to exercise the failure diagnostic after process exit.
        },
      });
      fixture.spawn({
        cmd: [
          process.execPath,
          '-e',
          `const descendant = Bun.spawn({
          cmd: [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
          stdout: 'ignore', stderr: 'ignore', stdin: 'ignore',
        });
        process.on('SIGTERM', async () => {
          descendant.kill('SIGKILL');
          await descendant.exited;
          process.exit(0);
        });
        console.log('descendant=' + descendant.pid);
        setInterval(() => {}, 1000);`,
        ],
      });
      await fixture.waitUntilReady(() => /descendant=\d+/.test(fixture.diagnostics()), {
        label: 'descendant pid',
        timeoutMs: 5_000,
      });
      const pid = fixture.diagnostics().match(/descendant=(\d+)/)?.[1];
      expect(pid).toBeDefined();
      await expect(fixture.cleanup()).rejects.toThrow(
        `pid=${pid} observedParent=${fixture.child?.pid}`
      );
      await expect(fixture.cleanup()).rejects.toThrow('currentParent=<absent>');
      expect(fixture.child?.exitCode).toBe(0);
    }
  );

  it('preserves live-child and occupied-port release failures', async () => {
    const fixture = await createFixture();
    const child = fixture.spawn({ cmd: [process.execPath, '-e', 'setInterval(() => {}, 1000)'] });
    await expect(fixture.assertReleased()).rejects.toThrow(
      `Child process ${child.pid} is still running`
    );
    await expect(fixture.assertReleased()).rejects.toThrow(`child: pid=${child.pid}`);
    await fixture.stop('SIGKILL');

    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(fixture.port, '127.0.0.1', resolve);
    });
    try {
      await expect(fixture.cleanup()).rejects.toThrow('EADDRINUSE');
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
