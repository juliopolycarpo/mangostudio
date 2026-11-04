import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { listenIpc } from '../../src/transports/ipc';
const dir = await mkdtemp(join(tmpdir(), 'ipc-node-bound-'));
const limit = process.platform === 'linux' ? 107 : 103;
const parent = join(dir, 'x'.repeat(limit - Buffer.byteLength(dir) - 3));
const path = join(parent, 's');
await mkdir(parent);
const raw = createServer();
let listener: Awaited<ReturnType<typeof listenIpc>> | undefined;
let oversizedListener: Awaited<ReturnType<typeof listenIpc>> | undefined;
async function dial(pathname: string): Promise<void> {
  const socket = connect(pathname);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.once('connect', resolve);
    });
  } finally {
    socket.destroy();
  }
}
try {
  await new Promise<void>((resolve, reject) => {
    raw.once('error', reject);
    raw.listen(path, resolve);
  });
  await new Promise<void>((resolve) => raw.close(() => resolve()));
  listener = await listenIpc(path, () => undefined);
  assert((await stat(path)).isSocket());
  await dial(path);
  // Check one and two bytes beyond the SDK ceiling. Node/Linux may dial an
  // unterminated 108-byte pathname even though Rust's native constructor rejects it.
  for (const suffix of ['xxx', 'xx']) {
    const oversized = join(parent, suffix);
    let refusal: NodeJS.ErrnoException | undefined;
    try {
      oversizedListener = await listenIpc(oversized, () => undefined);
    } catch (error) {
      refusal = error as NodeJS.ErrnoException;
    }
    if (oversizedListener) {
      let dialError: NodeJS.ErrnoException | undefined;
      try {
        await dial(oversized);
      } catch (error) {
        dialError = error as NodeJS.ErrnoException;
      }
      assert.fail(
        `listenIpc accepted ${Buffer.byteLength(oversized)} public bytes; native net.connect result: ${dialError?.code ?? 'connected'}`
      );
    }
    assert.equal(refusal?.code, 'ENAMETOOLONG');
    await assert.rejects(stat(oversized), { code: 'ENOENT' });
  }
  process.stdout.write(
    `passed: native Node Unix boundary public path ${Buffer.byteLength(path)}\n`
  );
} finally {
  await new Promise<void>((resolve) => raw.close(() => resolve()));
  await listener?.close();
  await oversizedListener?.close();
  await rm(dir, { recursive: true, force: true });
}
