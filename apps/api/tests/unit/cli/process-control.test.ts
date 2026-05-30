import { describe, expect, it } from 'bun:test';
import { createProcessController, waitForExit } from '../../../src/cli/process-control';
import { FakeProcessController } from '../../support/mocks/fake-process-controller';

const NEVER_A_PID = 2_147_483_646;
const noSleep = (): Promise<void> => Promise.resolve();

describe('createProcessController.isAlive', () => {
  it('reports the current process as alive', () => {
    expect(createProcessController().isAlive(process.pid)).toBe(true);
  });

  it('reports an unused pid as dead', () => {
    expect(createProcessController().isAlive(NEVER_A_PID)).toBe(false);
  });
});

describe('waitForExit', () => {
  const waitOpts = (now: () => number, sleep: (ms: number) => Promise<void>) => ({
    timeoutMs: 1000,
    intervalMs: 100,
    now,
    sleep,
  });

  it('returns true immediately when the pid is already dead', async () => {
    const controller = new FakeProcessController();
    const result = await waitForExit(
      controller,
      10,
      waitOpts(() => 0, noSleep)
    );
    expect(result).toBe(true);
  });

  it('returns true once the pid dies before the deadline', async () => {
    const controller = new FakeProcessController([10]);
    let now = 0;
    const sleep = (ms: number): Promise<void> => {
      now += ms;
      if (now >= 250) {
        controller.die(10);
      }
      return Promise.resolve();
    };

    const result = await waitForExit(
      controller,
      10,
      waitOpts(() => now, sleep)
    );
    expect(result).toBe(true);
    expect(now).toBeLessThan(1000);
  });

  it('returns false when the pid never dies before the timeout', async () => {
    const controller = new FakeProcessController([10]);
    let now = 0;
    const sleep = (ms: number): Promise<void> => {
      now += ms;
      return Promise.resolve();
    };

    const result = await waitForExit(controller, 10, {
      timeoutMs: 500,
      intervalMs: 100,
      now: () => now,
      sleep,
    });
    expect(result).toBe(false);
  });
});
