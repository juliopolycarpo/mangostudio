import { afterEach, onTestFinished, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DrainFixtureScope,
  type LiveDrainFixture,
  withOwnedDrainFixture,
} from './worker-drain-fixture';
import { settleWorkerLanesBeforeRemoval, WorkerLaneOwner } from './worker-lane-cleanup';

export interface WorkerDrainLifecycleEvent {
  event: string;
  channelOpen?: boolean;
  laneLive?: boolean;
  callbackPending?: boolean;
  directory?: boolean;
}

const directory = mkdtempSync(join(tmpdir(), 'drain-lifecycle-owned-'));
const controller = new AbortController();
const lane = new WorkerLaneOwner(controller);
let channelOpen = true;
let laneLive = true;
let callbackPending = true;
let nativeLive = true;
const channel: LiveDrainFixture = {
  env: {},
  nativePid: 4242,
  get holdingPipes() {
    return channelOpen;
  },
  get settled() {
    return !channelOpen;
  },
  ready: () => Promise.resolve(4242),
  close: () => {
    channelOpen = false;
    return Promise.resolve();
  },
};
const scope = new DrainFixtureScope(controller.signal, {
  create: () => Promise.resolve(channel),
  readNativeAlive: () => Promise.resolve(nativeLive),
  now: () => performance.now(),
  pause: (ms) => Bun.sleep(ms),
});
lane.track(scope.closed);
const running = new Promise<void>((resolve) => {
  controller.signal.addEventListener(
    'abort',
    () => {
      setTimeout(() => {
        laneLive = false;
        nativeLive = false;
        resolve();
      }, 25);
    },
    { once: true }
  );
});
afterEach(async () => {
  console.log(
    JSON.stringify({
      event: 'afterEach',
      channelOpen,
      laneLive,
      callbackPending,
      directory: existsSync(directory),
    })
  );
  await settleWorkerLanesBeforeRemoval([lane], () => {
    console.log(JSON.stringify({ event: 'removed', channelOpen, laneLive, callbackPending }));
    rmSync(directory, { recursive: true, force: true });
  });
});
test('held drain setup hits test deadline', async () => {
  onTestFinished(async () => {
    console.log(JSON.stringify({ event: 'onTestFinished', directory: existsSync(directory) }));
    await lane.close();
  });
  await lane.run(async () => {
    await scope.allocate();
    scope.markLaneStarted();
    void lane.start(() => running);
    await withOwnedDrainFixture(scope, {
      async start() {
        try {
          await new Promise<void>((_resolve, reject) =>
            controller.signal.addEventListener('abort', () => reject(controller.signal.reason), {
              once: true,
            })
          );
          return 'done';
        } finally {
          callbackPending = false;
        }
      },
      readPid: () => 4242,
      check: () => undefined,
    });
  });
}, 80);
