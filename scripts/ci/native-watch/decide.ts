// Decisions for the scheduled native platform run: whether `main` moved since
// the last green scheduled run, and what to do with the tracking issue once the
// run has a verdict. Network access goes through `NativeWatchApi`.

import type { NativeWatchApi, TrackingIssue } from './api';

const NATIVE_WORKFLOW_FILE = 'native-bun-qualification.yml';
const BOT_LOGIN = 'github-actions[bot]';
const ISSUE_LABELS = ['type: ci', 'status: needs triage'] as const;
// A job that reaches its job-level timeout is reported as cancelled, so a hang
// is a failure here. A run cancelled by a person never reaches the report: the
// workflow skips that step under cancelled().
const FAILING_CONCLUSIONS = new Set(['failure', 'cancelled', 'timed_out']);

export type NativeVerdict = 'success' | 'failure' | 'cancelled' | 'skipped';

export function parseNativeVerdict(value: string | undefined): NativeVerdict {
  if (value === 'success' || value === 'failure' || value === 'cancelled' || value === 'skipped') {
    return value;
  }
  throw new Error(
    `Invalid verdict ${JSON.stringify(value)}; expected success, failure, cancelled or skipped`
  );
}

/**
 * A scheduled run is redundant when the last successful scheduled run already
 * qualified this exact commit. Manual dispatches and pull requests always run.
 * @example await shouldSkipScheduledRun({ api, event: 'schedule', sha });
 */
export async function shouldSkipScheduledRun(options: {
  api: NativeWatchApi;
  event: string;
  sha: string;
  branch?: string;
}): Promise<{ skip: boolean; reason: string }> {
  if (options.event !== 'schedule') {
    return { skip: false, reason: `${options.event} runs are never skipped` };
  }
  const last = await options.api.lastSuccessfulScheduledSha(
    NATIVE_WORKFLOW_FILE,
    options.branch ?? 'main'
  );
  if (last === options.sha) {
    return {
      skip: true,
      reason: `main is still at ${options.sha}, last qualified by a scheduled run`,
    };
  }
  return {
    skip: false,
    reason:
      last === null
        ? 'no successful scheduled run yet'
        : `main moved from ${last} to ${options.sha}`,
  };
}

/** Hidden marker that ties an issue to one ref, so a branch dispatch never touches main's issue. */
export function trackingMarker(ref: string): string {
  return `<!-- native-platform-watch ref=${ref} -->`;
}

function branchName(ref: string): string {
  return ref.replace(/^refs\/heads\//, '');
}

function ownedIssues(issues: readonly TrackingIssue[], ref: string): TrackingIssue[] {
  const marker = trackingMarker(ref);
  return issues
    .filter((issue) => issue.author === BOT_LOGIN && issue.body.includes(marker))
    .sort((left, right) => left.number - right.number);
}

export interface ReportOptions {
  api: NativeWatchApi;
  ref: string;
  sha: string;
  runId: number;
  runUrl: string;
  /** `cancelled` means a job timed out; see FAILING_CONCLUSIONS. */
  verdict: NativeVerdict;
  /** The triggering event: only a schedule (or a rehearsal) writes the tracking issue. */
  event: string;
  /** Log every mutation instead of performing it. */
  dryRun: boolean;
  /** Pretend the run failed or passed without native jobs, to exercise the issue paths. */
  rehearsal?: 'failure' | 'success';
  log?: (line: string) => void;
}

/** Whether a report body has a `Run: <url>` line for exactly this run; `/runs/7` must not match `/runs/70`. */
function namesRun(text: string, runUrl: string): boolean {
  return text.split(/\r?\n/).some((line) => line.trim() === `Run: ${runUrl}`);
}

async function failingJobLines(options: ReportOptions): Promise<string[]> {
  if (options.rehearsal === 'failure') return ['- rehearsal: no native job ran'];
  const jobs = await options.api.listJobs(options.runId);
  return jobs
    .filter((job) => job.conclusion !== null && FAILING_CONCLUSIONS.has(job.conclusion))
    .map((job) => `- ${job.name}: ${job.conclusion}`);
}

function issueBody(options: ReportOptions, failing: readonly string[]): string {
  return [
    trackingMarker(options.ref),
    `The scheduled native Bun qualification failed on \`${branchName(options.ref)}\` at \`${options.sha}\`.`,
    '',
    'Failing jobs:',
    ...(failing.length > 0 ? failing : ['- none reported; read the run for the failing step']),
    '',
    `Run: ${options.runUrl}`,
    '',
    'The workflow comments here on each later failing run and closes this issue on the next green one.',
  ].join('\n');
}

/**
 * Apply a run's verdict to the tracking issue: open it (or comment on the open
 * one) after a failure or a timed-out job, comment and close it after a pass,
 * leave it alone when the run was skipped. A manual dispatch reports nothing
 * (its branch and its issue would outlive each other), and a rehearsal on main
 * must be a dry run so it cannot touch the real issue.
 * @example await reportNativeResult({ api, ref: 'refs/heads/main', sha, runId, runUrl, verdict: 'failure', dryRun: false });
 */
export async function reportNativeResult(options: ReportOptions): Promise<void> {
  const log = options.log ?? console.log;
  const act = async (description: string, mutate: () => Promise<unknown>): Promise<void> => {
    if (options.dryRun) log(`dry run: would ${description}`);
    else {
      await mutate();
      log(description);
    }
  };
  if (options.rehearsal !== undefined && options.ref === 'refs/heads/main' && !options.dryRun) {
    throw new Error(
      `Invalid rehearsal ${options.rehearsal} on refs/heads/main without a dry run; expected a branch ref or dry_run`
    );
  }
  if (options.event !== 'schedule' && options.rehearsal === undefined) {
    log(`${options.event} run; only scheduled runs and rehearsals report`);
    return;
  }
  const verdict = options.rehearsal ?? options.verdict;
  if (verdict === 'skipped') {
    log('run skipped; the tracking issue is left as it is');
    return;
  }
  const open = ownedIssues(await options.api.listOpenIssues(ISSUE_LABELS[0]), options.ref);

  if (verdict === 'success') {
    if (open.length === 0) return log('run passed and no tracking issue is open');
    for (const issue of open) {
      await act(`comment on and close issue #${issue.number}`, async () => {
        await options.api.commentOnIssue(
          issue.number,
          `The native Bun qualification passed at \`${options.sha}\`: ${options.runUrl}\n\nClosing.`
        );
        await options.api.closeIssue(issue.number);
      });
    }
    return;
  }

  // `cancelled` reaches here only for a timed-out job; a person cancelling the
  // run skips the report step, so both fall through to the failure path.
  const failing = await failingJobLines(options);
  const [existing] = open;
  if (existing === undefined) {
    const title = `ci: native platform tests failing on ${branchName(options.ref)}`;
    await act(`open an issue "${title}" for ${failing.join(' ') || 'an unnamed failure'}`, () =>
      options.api.createIssue({
        title,
        body: issueBody(options, failing),
        labels: ISSUE_LABELS,
      })
    );
    return;
  }
  // A re-run of the same workflow run must not repeat its own report. The run
  // that opened the issue names its URL in the issue body, not in a comment.
  const comments = await options.api.listIssueCommentBodies(existing.number);
  if ([existing.body, ...comments].some((text) => namesRun(text, options.runUrl))) {
    return log(`issue #${existing.number} already names ${options.runUrl}`);
  }
  await act(`comment on open issue #${existing.number}`, () =>
    options.api.commentOnIssue(
      existing.number,
      [
        `Still failing at \`${options.sha}\`.`,
        '',
        'Failing jobs:',
        ...(failing.length > 0 ? failing : ['- none reported; read the run for the failing step']),
        '',
        `Run: ${options.runUrl}`,
      ].join('\n')
    )
  );
}
