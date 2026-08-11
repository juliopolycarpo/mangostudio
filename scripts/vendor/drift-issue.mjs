/**
 * The tracking issue the scheduled drift job keeps.
 *
 * Plain ESM rather than TypeScript so `actions/github-script` can import it
 * directly, matching `scripts/qa-gate/publish/*.mjs`. Living in a module rather
 * than inline in the workflow is what makes the issue body testable — the plan
 * this implements asks for the issue-opening path to be exercised, and a
 * heredoc inside YAML cannot be.
 *
 * **One issue, updated in place.** A vendor that moves stays moved until
 * somebody re-records, so a weekly job that opened a new issue every Wednesday
 * would produce a backlog of identical reports. It finds its own issue by a
 * marker in the body, updates it while the drift persists, and closes it once
 * the vendors match again — so the issue's existence means "there is drift
 * right now", which is the only state worth a notification.
 */

/** Hidden in the body, because titles get edited and labels get removed. */
export const DRIFT_MARKER = '<!-- vendor-drift -->';

export const DRIFT_TITLE = 'Vendor contract drift against latest';

/**
 * The repository's classification gate requires at least one `area:` or
 * `type:` label, and both carry the space — `.github/labeler.yml` is what the
 * gate reads.
 */
export const DRIFT_LABELS = ['type: dependencies', 'area: runtime'];

/**
 * Outcomes worth an issue.
 *
 * `skipped` is excluded deliberately: a runner without vendor credentials is
 * the ordinary case, and filing an issue about it every week would bury the
 * one it exists to surface. The step summary still says what went unverified.
 */
export function driftedOutcomes(report) {
  return (report?.outcomes ?? []).filter(
    (outcome) => outcome.status !== 'matched' && outcome.status !== 'skipped'
  );
}

/** Whether anything in this report needs a maintainer to look. */
export function hasDrift(report) {
  return driftedOutcomes(report).length > 0;
}

function renderOutcome(outcome) {
  const changes = outcome.changes?.length ? outcome.changes.join('\n') : '(no field-level detail)';
  return [
    `### \`${outcome.id}\` — ${outcome.status} on \`${outcome.observedVersion ?? 'unknown'}\``,
    '',
    '```',
    changes,
    '```',
  ].join('\n');
}

/** The issue body, including the marker that lets the next run find it. */
export function renderIssueBody(report, runUrl) {
  const drifted = driftedOutcomes(report);
  const unverified = (report?.outcomes ?? []).filter(
    (outcome) => outcome.status === 'skipped' || outcome.partial
  );
  const lines = [
    DRIFT_MARKER,
    '',
    'A scheduled run captured the vendor CLIs at **latest** and compared them with the committed',
    'contracts.',
    '',
    '- **added** — the vendor grew a field. Nothing is broken; re-record when convenient.',
    '- **removed** / **changed** — an adapter may be reading something the newest build no longer',
    '  produces. This is the one worth reading today.',
    '',
    'Re-record with `bun run vendor-contracts:regen` on a machine with the vendor CLIs signed in,',
    'and read the diff before committing it.',
    '',
    ...drifted.map(renderOutcome),
  ];
  if (unverified.length > 0) {
    lines.push(
      '',
      '### Not verified by this run',
      '',
      ...unverified.map((outcome) => {
        const reason = outcome.partial?.reason ?? 'its tool was not available on the runner';
        const names = outcome.partial ? ` (${outcome.partial.names.join(', ')})` : '';
        return `- \`${outcome.id}\`${names} — ${reason}`;
      })
    );
  }
  if (runUrl) lines.push('', `_Run: ${runUrl}_`);
  return lines.join('\n');
}

/** The open issue this job owns, or `undefined` when there is none. */
async function findOpenIssue({ github, context }) {
  const listed = await github.rest.issues.listForRepo({
    owner: context.repo.owner,
    repo: context.repo.repo,
    state: 'open',
    labels: DRIFT_LABELS[0],
    per_page: 100,
  });
  return listed.data.find((issue) => (issue.body ?? '').includes(DRIFT_MARKER));
}

/** Opens, updates or closes the tracking issue to match this run's report. */
export async function publishDriftIssue({ github, context, core }, report, runUrl) {
  const repo = { owner: context.repo.owner, repo: context.repo.repo };
  const existing = await findOpenIssue({ github, context });

  if (!hasDrift(report)) {
    core.info('Vendors at latest match the committed contracts.');
    if (!existing) return { action: 'none' };
    await github.rest.issues.createComment({
      ...repo,
      issue_number: existing.number,
      body: `${DRIFT_MARKER}\nThe vendors at latest match the committed contracts again.`,
    });
    await github.rest.issues.update({ ...repo, issue_number: existing.number, state: 'closed' });
    core.info(`Closed #${existing.number}.`);
    return { action: 'closed', number: existing.number };
  }

  const body = renderIssueBody(report, runUrl);
  if (existing) {
    await github.rest.issues.update({
      ...repo,
      issue_number: existing.number,
      title: DRIFT_TITLE,
      body,
    });
    core.info(`Updated #${existing.number}.`);
    return { action: 'updated', number: existing.number };
  }
  const created = await github.rest.issues.create({
    ...repo,
    title: DRIFT_TITLE,
    body,
    labels: DRIFT_LABELS,
  });
  core.info(`Opened #${created.data.number}.`);
  return { action: 'opened', number: created.data.number };
}
