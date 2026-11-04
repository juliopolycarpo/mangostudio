import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
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
try {
  await new Promise<void>((resolve, reject) => {
    raw.once('error', reject);
    raw.listen(path, resolve);
  });
  await new Promise<void>((resolve) => raw.close(() => resolve()));
  listener = await listenIpc(path, () => undefined);
  assert((await stat(path)).isSocket());
  process.stdout.write(
    `passed: native Node Unix boundary public path ${Buffer.byteLength(path)}\n`
  );
} finally {
  await new Promise<void>((resolve) => raw.close(() => resolve()));
  await listener?.close();
  await rm(dir, { recursive: true, force: true });
}
