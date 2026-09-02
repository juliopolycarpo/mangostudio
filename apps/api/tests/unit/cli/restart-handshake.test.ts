import { describe, expect, it } from 'bun:test';
import { predecessorPid, waitForPredecessor } from '../../../src/cli/restart-handshake';
import { FakeProcessController } from '../../support/mocks/fake-process-controller';

describe('predecessorPid', () => {
  it('reads a positive integer pid and nothing else', () => {
    expect(predecessorPid({ MANGO_RESTART_WAIT_PID: '42' })).toBe(42);
    expect(predecessorPid({ MANGO_RESTART_WAIT_PID: '0' })).toBeNull();
    expect(predecessorPid({ MANGO_RESTART_WAIT_PID: 'abc' })).toBeNull();
    expect(predecessorPid({})).toBeNull();
  });
});

describe('waitForPredecessor', () => {
  it('returns once the predecessor is gone', async () => {
    const controller = new FakeProcessController([42]);
    let now = 0;
    const gone = await waitForPredecessor(42, {
      controller,
      now: () => now,
      sleep: (ms) => {
        now += ms;
        controller.die(42);
        return Promise.resolve();
      },
    });
    expect(gone).toBe(true);
  });

  it('gives up after its budget instead of hanging', async () => {
    let now = 0;
    const gone = await waitForPredecessor(42, {
      controller: new FakeProcessController([42]),
      now: () => now,
      sleep: (ms) => {
        now += ms;
        return Promise.resolve();
      },
    });
    expect(gone).toBe(false);
  });
});
