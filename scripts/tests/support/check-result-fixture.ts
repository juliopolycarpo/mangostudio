import type { CheckResult, CheckTaskResult } from '../../lib/check-result';

export const CHECK_INVOCATION_ID = '12345678-1234-1234-1234-123456789abc';

/** Named task fixtures, independent of the CLI's report construction. */
export const executedCheckTask = (
  label: string,
  exitCode = 0
): Extract<CheckTaskResult, { state: 'executed' }> => ({
  label,
  state: 'executed',
  exitCode,
  durationMs: 12,
});

export const completedCheckFixture = (
  tasks: CheckTaskResult[] = [executedCheckTask('workspaces:check')]
): CheckResult => ({
  kind: 'mangostudio.check-result',
  schemaVersion: 1,
  invocationId: CHECK_INVOCATION_ID,
  args: ['--all'],
  state: 'completed',
  exitCode: tasks.some((task) => task.state === 'executed' && task.exitCode !== 0) ? 1 : 0,
  error: null,
  plannedTasks: tasks.map((task) => task.label),
  tasks,
});
