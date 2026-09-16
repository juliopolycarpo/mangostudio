import { describe, expect, test } from 'bun:test';
import { type RunResult, runSequential } from '../lib/exec';

// `runSequential` exists because some task pairs share a tree — formatters, or
// two cargo lanes writing the same target/ — and running them concurrently
// races rather than interleaves. Ordering is therefore the contract, not an
// implementation detail, and a refactor to `Promise.all` would keep every other
// assertion green.

/** Records the order tasks were entered and left, so overlap is observable. */
class RecordingTasks {
  readonly events: string[] = [];

  task(label: string, exitCode = 0): () => Promise<RunResult> {
    return async () => {
      this.events.push(`start:${label}`);
      await Bun.sleep(1);
      this.events.push(`end:${label}`);
      return { label, exitCode, duration: 0 };
    };
  }
}

describe('runSequential', () => {
  test('never starts a task before the previous one finished', async () => {
    const recorder = new RecordingTasks();
    await runSequential([recorder.task('a'), recorder.task('b'), recorder.task('c')]);

    expect(recorder.events).toEqual(['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c']);
  });

  test('collects every result in order, including the failures', async () => {
    const recorder = new RecordingTasks();
    const results = await runSequential([recorder.task('a', 0), recorder.task('b', 7)]);

    expect(results.map((result) => [result.label, result.exitCode])).toEqual([
      ['a', 0],
      ['b', 7],
    ]);
  });

  test('keeps going after a failing task, so the summary names every lane', () => {
    // The callers hand the whole array to `exitWithResults`, which prints one
    // pass/fail line per task; stopping at the first failure would hide the rest.
    const recorder = new RecordingTasks();
    return runSequential([recorder.task('a', 1), recorder.task('b', 0)]).then((results) => {
      expect(results).toHaveLength(2);
      expect(recorder.events).toContain('start:b');
    });
  });

  test('answers with an empty list for no tasks', async () => {
    expect(await runSequential([])).toEqual([]);
  });
});
