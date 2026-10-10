import { describe, expect, it } from 'bun:test';
import { expectRuntimeChildAlive } from '../../support/runtime-child-liveness';

/** A runtime child whose exit the test triggers by hand. */
class FakeRuntimeChild {
  readonly exited: Promise<number>;
  private finish!: (code: number) => void;

  constructor() {
    this.exited = new Promise<number>((resolve) => {
      this.finish = resolve;
    });
  }

  exitWith(code: number): void {
    this.finish(code);
  }
}

/** What the guard did: its rejection message, or `resolved` when it let the child through. */
async function outcomeOf(guard: Promise<void>): Promise<string> {
  try {
    await guard;
    return 'resolved';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe('expectRuntimeChildAlive', () => {
  it('resolves when the child is still running at the end of the window', async () => {
    const child = new FakeRuntimeChild();

    const outcome = await outcomeOf(expectRuntimeChildAlive(child, 30));

    expect(outcome, 'expected guard outcome: resolved | received: a rejection').toBe('resolved');
  });

  it('names the window and the exit code when the child exits inside it', async () => {
    const child = new FakeRuntimeChild();

    const guard = outcomeOf(expectRuntimeChildAlive(child, 5_000));
    child.exitWith(143);

    expect(await guard).toStartWith(
      'expected runtime child: alive at 5 s | received: exited with code 143 after '
    );
  });

  it('rejects a child that had already exited before the guard started', async () => {
    const child = new FakeRuntimeChild();
    child.exitWith(1);

    const outcome = await outcomeOf(expectRuntimeChildAlive(child, 5_000));

    expect(outcome).toStartWith(
      'expected runtime child: alive at 5 s | received: exited with code 1 after '
    );
  });

  it('refuses a window that could never fail', async () => {
    const child = new FakeRuntimeChild();

    expect(await outcomeOf(expectRuntimeChildAlive(child, 0))).toBe(
      'expected windowMs: positive finite number | received: 0'
    );
    expect(await outcomeOf(expectRuntimeChildAlive(child, Number.NaN))).toBe(
      'expected windowMs: positive finite number | received: NaN'
    );
  });
});
