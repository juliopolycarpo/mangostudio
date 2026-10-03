const START = '<!-- rust-fresh-dependencies -->';
const END = '<!-- /rust-fresh-dependencies -->';

// What each failed stage means for the reader. `passed` never reaches a report.
const STAGE_LINES = {
  'resolution-failed':
    'Dependency resolution failed: no new lockfile was produced, so there is no resolved graph to inspect. Read the resolver step of the workflow logs.',
  'lock-not-retained':
    'Dependency resolution succeeded, but the resolved lockfile could not be retained; the policy and platform checks did not run.',
  'policy-failed':
    'The resolved graph was built and tested on every platform, but the dependency policy failed.',
  'platform-checks-failed':
    'The resolved graph passed the dependency policy, but a platform build, lint or test check failed.',
  'policy-and-platform-checks-failed':
    'The resolved graph failed both the dependency policy and a platform build, lint or test check.',
  incomplete:
    'A stage neither passed nor failed (it was skipped or cancelled), so the outcome is incomplete. Read the workflow logs.',
};

/**
 * Update the single bot-owned dependency compatibility issue, preserving maintainer notes.
 * `outcome` is the stage `classifyFreshRun` named; `lockSha256` is the resolved lock's hash,
 * or null when no lock was produced.
 * // Usage: await reportFreshDependencies({ github, context, revision, runUrl, outcome: 'policy-failed', lockSha256 });
 */
export async function reportFreshDependencies({
  github,
  context,
  revision,
  runUrl,
  outcome,
  lockSha256,
}) {
  if (!/^[a-f0-9]{40}$/.test(revision)) {
    throw new Error(
      `Invalid revision ${JSON.stringify(revision)}; expected a 40-character Git SHA`
    );
  }
  if (!(outcome in STAGE_LINES)) {
    throw new Error(
      `Invalid outcome ${JSON.stringify(outcome)}; expected one of ${Object.keys(STAGE_LINES).join(', ')}`
    );
  }
  if (lockSha256 !== null && !/^[a-f0-9]{64}$/.test(lockSha256)) {
    throw new Error(
      `Invalid lock SHA-256 ${JSON.stringify(lockSha256)}; expected 64 lowercase hex characters or null`
    );
  }
  const repo = context.repo;
  const issues = await github.paginate(github.rest.issues.listForRepo, {
    ...repo,
    state: 'all',
    labels: 'type: dependencies',
    per_page: 100,
  });
  const matches = issues.filter(
    (issue) =>
      !issue.pull_request &&
      issue.user?.login === 'github-actions[bot]' &&
      issue.body?.includes(START)
  );
  if (matches.length > 1) {
    throw new Error(
      `Received compatibility issues ${matches.map((issue) => issue.number).join(', ')}; expected at most one managed issue`
    );
  }
  const report = [
    START,
    `The fresh Rust dependency check failed at commit \`${revision}\`.`,
    '',
    STAGE_LINES[outcome],
    '',
    lockSha256
      ? `[Workflow logs and resolved lockfile](${runUrl}), lockfile SHA-256 \`${lockSha256}\`.`
      : `[Workflow logs](${runUrl})`,
    '',
    `This scheduled check resolves compatible dependencies independently of the committed lockfile. Exact SDK pins remain exact. ${
      lockSha256
        ? 'Inspect the failing command and resolved lockfile before proposing a dependency change.'
        : 'Inspect the failing command before proposing a dependency change.'
    }`,
    END,
  ].join('\n');
  const existing = matches[0];
  if (!existing) {
    const result = await github.rest.issues.create({
      ...repo,
      title: 'Fresh Rust dependency resolution fails compatibility checks',
      body: report,
      labels: ['type: dependencies', 'status: needs triage'],
    });
    return result.data.number;
  }
  const start = existing.body.indexOf(START);
  const end = existing.body.indexOf(END, start + START.length);
  if (
    end < 0 ||
    existing.body.indexOf(END) !== end ||
    existing.body.indexOf(START, start + START.length) >= 0 ||
    existing.body.indexOf(END, end + END.length) >= 0
  ) {
    throw new Error(
      `Invalid managed section in issue ${existing.number}; expected exactly one ordered ${START} / ${END} pair`
    );
  }
  await github.rest.issues.update({
    ...repo,
    issue_number: existing.number,
    state: 'open',
    body: `${existing.body.slice(0, start)}${report}${existing.body.slice(end + END.length)}`,
  });
  return existing.number;
}
