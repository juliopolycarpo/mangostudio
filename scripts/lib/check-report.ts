// Thin optional report-file adapter. Pending evidence remains explicitly
// unavailable if Check is interrupted; only an atomic rename publishes a finish.

import { renameSync, writeFileSync } from 'node:fs';

import { type CheckResult, serializeCheckResult } from './check-result';

export interface CheckReportTarget {
  readonly path: string;
  readonly invocationId: string;
  readonly args: string[];
}

/** Remove only internal report flags from the recorded command invocation. */
export const checkReportTarget = (
  argv: readonly string[],
  values: Readonly<Record<string, string>>
): CheckReportTarget | null => {
  const path = values['--report-file'];
  const invocationId = values['--report-id'];
  if (!path && !invocationId) return null;
  if (!path || !invocationId || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(invocationId)) {
    throw new Error('--report-file and --report-id <UUID> must be supplied together');
  }
  const args: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--report-file' || arg === '--report-id') {
      index += 1;
    } else if (!arg.startsWith('--report-file=') && !arg.startsWith('--report-id=')) {
      args.push(arg);
    }
  }
  return { path, invocationId, args };
};

/** Publish one complete file; the temporary file is beside it for atomicity. */
export const writeCheckReport = (target: CheckReportTarget, result: CheckResult): void => {
  const text = serializeCheckResult(result);
  const temporary = `${target.path}.${process.pid}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600 });
  renameSync(temporary, target.path);
};

/** Identity shared by setup, pending and completed reports from this command. */
export const checkReportIdentity = (target: CheckReportTarget) => ({
  kind: 'mangostudio.check-result' as const,
  schemaVersion: 1 as const,
  invocationId: target.invocationId,
  args: target.args,
});
