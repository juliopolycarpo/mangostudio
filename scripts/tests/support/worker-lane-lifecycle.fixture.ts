import { afterEach, onTestFinished, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { settleWorkerLanesBeforeRemoval, WorkerLaneOwner } from './worker-lane-cleanup';

export interface WorkerLaneLifecycleEvent {
  event: string;
  live?: boolean;
  directory?: boolean;
}

const directory = mkdtempSync(join(tmpdir(), 'worker-lifecycle-owned-'));
const controller = new AbortController();
const owner = new WorkerLaneOwner(controller);
let live = true;
const lane = new Promise<void>((resolve) => {
  controller.signal.addEventListener(
    'abort',
    () => {
      console.log(JSON.stringify({ event: 'abort', live, directory: existsSync(directory) }));
      setTimeout(() => {
        live = false;
        console.log(JSON.stringify({ event: 'lane-settled', directory: existsSync(directory) }));
        resolve();
      }, 25);
    },
    { once: true }
  );
});
afterEach(async () => {
  console.log(JSON.stringify({ event: 'afterEach', live, directory: existsSync(directory) }));
  await settleWorkerLanesBeforeRemoval([owner], () => {
    console.log(JSON.stringify({ event: 'removed', live }));
    rmSync(directory, { recursive: true, force: true });
  });
});
test('held readiness hits test deadline', async () => {
  onTestFinished(async () => {
    console.log(
      JSON.stringify({ event: 'onTestFinished', live, directory: existsSync(directory) })
    );
    await owner.close();
  });
  void owner.start(() => lane);
  await owner.run(
    () =>
      new Promise<void>((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => reject(controller.signal.reason), {
          once: true,
        });
      })
  );
}, 80);
