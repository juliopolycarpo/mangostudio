import { describe, expect, test } from 'bun:test';

import { childEnd, type ChildEndState } from '../lib/child-end';

class FakeChild implements ChildEndState {
  constructor(
    readonly exitCode: number | null,
    readonly signalCode: string | number | null
  ) {}
}

describe('childEnd', () => {
  test('is null while the child runs', () => {
    expect(childEnd(new FakeChild(null, null))).toBeNull();
  });

  test('names the exit code of a child that exited', () => {
    expect(childEnd(new FakeChild(3, null))).toBe('exit 3');
    expect(childEnd(new FakeChild(0, null))).toBe('exit 0');
  });

  test('names the signal of a child a signal killed, which has no exit code', () => {
    expect(
      childEnd(new FakeChild(null, 'SIGKILL')),
      'expected a signalled child to count as ended'
    ).toBe('signal SIGKILL');
  });
});
