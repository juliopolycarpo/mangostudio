import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';

import { listenIpc } from '../../src/ipc';

/** Bind relative to one directory, then check close does not unlink in another. */
async function checkWorkingDirectoryChange(root: string): Promise<void> {
  const first = join(root, 'a');
  const second = join(root, 'b');
  await mkdir(first);
  await mkdir(second);
  process.chdir(first);
  const server = await listenIpc('s', () => undefined);
  let bait: string | undefined;
  try {
    const stage = (await readdir(first)).find((name) => name.startsWith('.mango-'));
    assert.ok(stage, 'expected private staging in the listener directory');
    process.chdir(second);
    await mkdir(stage);
    bait = join(stage, 's');
    await writeFile(bait, 'unrelated file');
  } finally {
    await server.close();
  }
  assert.ok(bait);
  assert.equal(await readFile(bait, 'utf8'), 'unrelated file');
  assert.deepEqual(await readdir(first), ['s']);

  const deep = join(root, 'd'.repeat(112));
  await mkdir(deep);
  process.chdir(deep);
  const shortAddress = await listenIpc('s', () => undefined);
  try {
    assert.ok((await stat('s')).isSocket());
    await assert.rejects(
      listenIpc('s', () => undefined),
      {
        code: 'EADDRINUSE',
        probeOutcome: 'connected',
      }
    );
  } finally {
    await shortAddress.close();
  }
}

/** Resolve a symlink before its parent segment when choosing the staging directory. */
async function checkSymlinkParent(root: string): Promise<void> {
  const source = join(root, 'a');
  const physical = join(root, 'b');
  await mkdir(source);
  await mkdir(join(physical, 'sub'), { recursive: true });
  await symlink(join(physical, 'sub'), join(source, 'link'));
  const listener = await listenIpc(`${source}/link/../s`, () => undefined);
  try {
    assert.ok((await stat(join(physical, 's'))).isSocket());
    assert.ok(
      (await readdir(physical)).some((name) => name.startsWith('.mango-')),
      'expected staging under the physical socket parent'
    );
    assert.deepEqual(await readdir(source), ['link']);
  } finally {
    await listener.close();
  }
}

if (!isMainThread) {
  const { endpoint } = workerData as { endpoint: string };
  const server = await listenIpc(endpoint, () => undefined);
  await server.close();
  parentPort?.postMessage('listened');
} else {
  const root = await mkdtemp(join(tmpdir(), 'mp-'));
  const cwd = process.cwd();
  try {
    if (process.argv[2] === 'cwd') await checkWorkingDirectoryChange(root);
    else if (process.argv[2] === 'symlink') await checkSymlinkParent(root);
    else if (process.argv[2] === 'worker') {
      const worker = new Worker(new URL(import.meta.url), {
        workerData: { endpoint: join(root, 's') },
      });
      const outcome = await new Promise<unknown>((resolve, reject) => {
        worker.once('error', reject);
        worker.once('message', resolve);
      });
      assert.equal(outcome, 'listened');
      assert.equal((await stat(join(root, 's'))).mode & 0o777, 0o600);
    } else {
      throw new Error(`Expected cwd, symlink or worker fixture | received: ${process.argv[2]}`);
    }
  } finally {
    process.chdir(cwd);
    await rm(root, { recursive: true, force: true });
  }
}
