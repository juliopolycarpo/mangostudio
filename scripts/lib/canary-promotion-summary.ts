/** Render workflow outcomes without inferring rollback from a failed publishing job.
 * @example renderCanaryPromotionSummary(needs, workflowRevision, runUrl)
 */
export function renderCanaryPromotionSummary(
  needs: unknown,
  workflowRevision: string,
  runUrl: string
): string {
  const jobs = object(needs, 'canary needs');
  if (!/^[a-f0-9]{40}$/.test(workflowRevision))
    throw new Error(`Invalid workflow revision ${workflowRevision}: expected full SHA`);
  if (!/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/actions\/runs\/\d+$/.test(runUrl))
    throw new Error(`Invalid canary run URL ${runUrl}: expected GitHub Actions run URL`);
  const source = object(jobs.source, 'source job');
  const approval = object(jobs.approve, 'approval job');
  const selected = object(source.outputs, 'source outputs');
  const approved = object(approval.outputs, 'approval outputs');
  const rows = ['| Channel | Job result | Interpretation |', '| --- | --- | --- |'];
  for (const [jobName, needed] of [
    ['npm-canary', 'npm_needed'],
    ['github-release-canary', 'github_needed'],
  ] as const) {
    const job = object(jobs[jobName], jobName);
    const result = job.result;
    if (!['success', 'failure', 'cancelled', 'skipped'].includes(String(result)))
      throw new Error(
        `Invalid ${jobName} result ${String(result)}: expected workflow job conclusion`
      );
    const state =
      result === 'success'
        ? 'Publisher completed its verification and recovery steps.'
        : result === 'skipped' && approval.result === 'success' && approved[needed] === 'false'
          ? 'Both-channel preflight verified this channel complete; no write was needed.'
          : 'External state may be partial or changed; rerun verification before retrying. Cancellation and failure do not roll back writes.';
    rows.push(`| ${jobName} | ${String(result)} | ${state} |`);
  }
  const evidence = JSON.stringify(
    {
      selected,
      approval: approved,
      channels: { npm: jobs['npm-canary'], github: jobs['github-release-canary'] },
    },
    null,
    2
  );
  if (evidence.length > 100_000)
    throw new Error(
      `Invalid summary evidence size ${evidence.length}: expected at most 100000 characters`
    );
  return [
    `# Canary ${typeof selected.version === 'string' ? selected.version : '(source unresolved)'}`,
    '',
    `Execution: ${runUrl}`,
    `Publisher execution revision: \`${workflowRevision}\`. Application source, original CI attempts, approval revision and artifact pointers are retained below.`,
    '',
    `Source job: ${String(source.result)}. Approval job: ${String(approval.result)}.`,
    `Preflight decision: ${typeof approved.reason === 'string' ? approved.reason : 'unavailable; no completion claim'}.`,
    '',
    ...rows,
    '',
    'Frozen evidence and immutable approval pointers:',
    '```json',
    evidence.replaceAll('```', '\\u0060\\u0060\\u0060'),
    '```',
    '',
    'Recovery uses the original approved bytes. Missing, expired or conflicting evidence fails; no rebuild fallback is permitted.',
    '',
  ].join('\n');
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`Invalid ${name}: expected object; received ${JSON.stringify(value)}`);
  return value as Record<string, unknown>;
}
