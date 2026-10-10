/**
 * Runs the protocol check lanes and settles the ones that were cut into
 * partitions. A command that runs as `count` slices has only passed when every
 * slice ran and exited 0: the slices that did run say nothing about a slice
 * that never started, was dropped from the task list or was cancelled, so each
 * of those is its own failure instead of a shorter green run.
 *
 * @example
 * exitWithResults(await runProtocolTasks(protocolCheckTasks(args), runTask));
 */

import type { RunResult } from '../lib/exec';
import { error } from '../lib/log';
import type { ProtocolTask } from './tasks';

/** Runs one task and resolves with how it ended; rejects when it could not be started. */
export type ProtocolTaskRunner = (task: ProtocolTask) => Promise<RunResult>;

/** A partition that did not run and pass, and what was observed instead. */
export interface UnsettledPartition {
  readonly label: string;
  readonly received: string;
}

function describeOutcome(result: RunResult | undefined): string {
  if (!result) return 'no result';
  return result.exitCode === 0 ? 'exit 0' : `exit ${result.exitCode}`;
}

/**
 * Every partition of a group that has no task, no result or a non-zero exit.
 * The group's size is the largest `count` any of its tasks declares, so a task
 * list holding only slice 1 of 2 still reports slice 2.
 *
 * @example
 * unsettledPartitions(tasks, results).map((entry) => entry.label);
 */
export function unsettledPartitions(
  tasks: readonly ProtocolTask[],
  results: readonly RunResult[]
): UnsettledPartition[] {
  const groups = new Map<string, ProtocolTask[]>();
  for (const task of tasks) {
    if (!task.partition) continue;
    groups.set(task.partition.group, [...(groups.get(task.partition.group) ?? []), task]);
  }

  const unsettled: UnsettledPartition[] = [];
  for (const [group, members] of groups) {
    const count = Math.max(...members.map((task) => task.partition?.count ?? 0));
    for (let index = 1; index <= count; index += 1) {
      const task = members.find((member) => member.partition?.index === index);
      const result = task && results.find((entry) => entry.label === task.label);
      if (result?.exitCode === 0) continue;
      const label = task?.label ?? `${group} (${index}/${count})`;
      unsettled.push({ label, received: task ? describeOutcome(result) : 'no such task' });
    }
  }
  return unsettled;
}

/**
 * Run every task at once and collect one result per task, then add a failing
 * result for each partition that did not run and pass. A task that fails or
 * cannot start never stops the others, so the diagnostics of every partition
 * are still printed.
 *
 * @example
 * const results = await runProtocolTasks(tasks, (task) => runCommand(task.label, task.cmd));
 */
export async function runProtocolTasks(
  tasks: readonly ProtocolTask[],
  run: ProtocolTaskRunner,
  report: (message: string) => void = error
): Promise<RunResult[]> {
  const results = await Promise.all(
    tasks.map(async (task): Promise<RunResult> => {
      try {
        return await run(task);
      } catch (caught) {
        const reason = caught instanceof Error ? caught.message : String(caught);
        report(`expected ${task.label} to start | received: ${reason}`);
        return { label: task.label, exitCode: 1, duration: 0 };
      }
    })
  );

  const unsettled = unsettledPartitions(tasks, results);
  const missing = unsettled.filter(({ label }) => !results.some((entry) => entry.label === label));
  for (const { label, received } of missing) {
    report(`expected ${label} to run and exit 0 | received: ${received}`);
  }
  return [
    ...results,
    ...missing.map(({ label }): RunResult => ({ label, exitCode: 1, duration: 0 })),
  ];
}
