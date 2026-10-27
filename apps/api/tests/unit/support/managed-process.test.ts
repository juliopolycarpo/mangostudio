import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';

import type { ProcessEntry } from '../../support/external-agents/process-tree';
import {
  createManagedProcessFixture,
  type ManagedProcessFixture,
} from '../../support/fixtures/managed-process';
import { createReleaseDiagnostics } from '../../support/fixtures/managed-process-diagnostics';

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
  it('removes nested storage with shell metacharacters in the allocated path', async () => {
    const fixture = await createFixture({ tempPrefix: 'mango-managed $; fixture-' });
    await mkdir(join(fixture.tempDir, 'nested'), { recursive: true });
    await writeFile(join(fixture.tempDir, 'nested', 'file'), '');
    await fixture.cleanup();
    await fixture.assertReleased();
  });

  it('accepts storage already removed before cleanup starts', async () => {
    const fixture = await createFixture();
    await rm(fixture.tempDir, { recursive: true });
    await fixture.cleanup();
    await fixture.assertReleased();
  });

  it.skipIf(process.platform === 'win32')(
    'removes directory links without following them',
    async () => {
      const fixture = await createFixture();
      const outside = await createFixture();
      const retainedFile = join(outside.tempDir, 'retained');
      await writeFile(retainedFile, '');
      await symlink(outside.tempDir, join(fixture.tempDir, 'link'));
      await fixture.cleanup();
      expect(existsSync(retainedFile)).toBe(true);
      await fixture.assertReleased();
    }
  );

  it.skipIf(process.platform !== 'linux')(
    'retains observed descendants and snapshot errors across failed and successful reads',
    async () => {
      const fixture = await createFixture();
      const child = fixture.spawn({ cmd: [process.execPath, '-e', ''] });
      const descendant = { pid: child.pid + 1, parentPid: child.pid, executable: '/fake/vendor' };
      const snapshotFailure = new Error('snapshot unavailable');
      const snapshots: Array<ProcessEntry[] | Error> = [[descendant], snapshotFailure, []];
      function readFakeProcessSnapshot(): ProcessEntry[] {
        const next = snapshots.shift();
        if (next === undefined) throw new Error('Unexpected process snapshot request');
        if (next instanceof Error) throw next;
        return next;
      }
      const diagnostics = createReleaseDiagnostics(fixture.tempDir, {
        readProcessSnapshot: readFakeProcessSnapshot,
      });
      diagnostics.observeProcesses(child);
      const expected = `pid=${descendant.pid} observedParent=${child.pid} currentParent=<absent>`;
      const failedSnapshot = diagnostics.describe(child);
      expect(failedSnapshot).toContain('descendant snapshot failed: Error: snapshot unavailable');
      expect(failedSnapshot).toContain(expected);
      const recoveredSnapshot = diagnostics.describe(child);
      expect(recoveredSnapshot).toContain(
        'descendant snapshot failed: Error: snapshot unavailable'
      );
      expect(recoveredSnapshot).toContain(expected);
      expect(snapshots).toHaveLength(0);
    }
  );

  it.each(['EACCES', 'ENOENT', 'ENOTDIR'])(
    'retains residual paths and continues after a directory read fails with %s',
    async (code) => {
      const fixture = await createFixture();
      const denied = join(fixture.tempDir, 'a-denied');
      const readable = join(fixture.tempDir, 'b-readable');
      await mkdir(denied);
      await mkdir(readable);
      await writeFile(join(readable, 'remaining'), 'private contents');
      const requests: string[] = [];
      function readFailingDirectory(path: string) {
        requests.push(path);
        if (path === denied)
          throw Object.assign(new Error(`${code}: directory unavailable`), { code });
        return readdirSync(path, { withFileTypes: true }).sort((a, b) =>
          a.name.localeCompare(b.name)
        );
      }
      const diagnostics = createReleaseDiagnostics(fixture.tempDir, {
        readDirectory: readFailingDirectory,
      }).describe(null);
      expect(diagnostics).toContain('"a-denied"');
      expect(diagnostics).toContain(`directory inspection failed: "a-denied": Error: ${code}`);
      expect(diagnostics).toContain(JSON.stringify(join('b-readable', 'remaining')));
      expect(diagnostics).not.toContain('private contents');
      expect(requests).toEqual([fixture.tempDir, denied, readable]);
    }
  );

  it('counts depth markers toward the residual diagnostic bound', async () => {
    const fixture = await createFixture();
    const deep = join('a', 'b', 'c', 'd');
    await mkdir(join(fixture.tempDir, deep), { recursive: true });
    for (let index = 0; index < 32; index += 1) {
      await mkdir(join(fixture.tempDir, deep, `branch-${index}`));
    }
    const diagnostics = createReleaseDiagnostics(fixture.tempDir).describe(null);
    const residual = diagnostics.split('residual paths:\n')[1]?.split('\nchild:')[0];
    expect(residual).toBeDefined();
    expect(residual).toContain('<depth limit reached>');
    expect(residual).toContain('<path limit reached>');
    expect(residual?.split('\n').filter((line) => line !== '<path limit reached>').length).toBe(32);
  });

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
    expect(String(failure)).toContain(JSON.stringify(join('.mango', 'run', 'server.json')));
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
