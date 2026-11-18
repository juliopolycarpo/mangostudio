import { describe, expect, it } from 'bun:test';

import {
  heldTailDelay,
  HeldTailTimer,
  scheduleUnrefTimer,
} from '../../../../src/modules/generation/application/held-tail-timer';
import { ManualHeldTailClock } from '../../../support/held-tail-clock';

describe('heldTailDelay', () => {
  it('counts the window from the last accepted write and never goes negative', () => {
    expect([
      heldTailDelay(1_000, 1_300, 1_000),
      heldTailDelay(1_000, 2_000, 1_000),
      heldTailDelay(1_000, 9_000, 1_000),
    ]).toEqual([700, 0, 0]);
  });
});

describe('HeldTailTimer', () => {
  it('keeps the first timer when armed again while one is waiting', () => {
    const clock = new ManualHeldTailClock(0);
    const timer = new HeldTailTimer(clock.schedule);
    const fired: string[] = [];

    timer.arm(700, () => fired.push('first'));
    timer.arm(100, () => fired.push('second'));
    clock.advance(1_000);

    expect({ fired, scheduled: clock.scheduled }).toEqual({ fired: ['first'], scheduled: 1 });
  });

  it('can be armed again after it fired', () => {
    const clock = new ManualHeldTailClock(0);
    const timer = new HeldTailTimer(clock.schedule);
    let fired = 0;

    timer.arm(10, () => (fired += 1));
    clock.advance(10);
    timer.arm(10, () => (fired += 1));
    clock.advance(10);

    expect(fired).toBe(2);
  });

  it('does not fire a cancelled timer', () => {
    const clock = new ManualHeldTailClock(0);
    const timer = new HeldTailTimer(clock.schedule);
    let fired = 0;

    timer.arm(10, () => (fired += 1));
    timer.cancel();
    clock.advance(100);

    expect({ fired, armed: timer.armed }).toEqual({ fired: 0, armed: false });
  });

  it('refuses to arm once closed', () => {
    const clock = new ManualHeldTailClock(0);
    const timer = new HeldTailTimer(clock.schedule);
    let fired = 0;

    timer.close();
    timer.arm(10, () => (fired += 1));
    clock.advance(100);

    expect({ fired, scheduled: clock.scheduled }).toEqual({ fired: 0, scheduled: 0 });
  });
});

describe('scheduleUnrefTimer', () => {
  it('runs the callback after the delay', async () => {
    const ran = await new Promise<boolean>((resolve) => {
      scheduleUnrefTimer(() => resolve(true), 1);
    });
    expect(ran).toBe(true);
  });

  it('does not run a cancelled callback', async () => {
    let ran = false;
    const cancel = scheduleUnrefTimer(() => {
      ran = true;
    }, 1);
    cancel();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(ran).toBe(false);
  });
});
