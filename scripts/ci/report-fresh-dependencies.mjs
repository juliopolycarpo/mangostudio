const START = '<!-- rust-fresh-dependencies -->';
const END = '<!-- /rust-fresh-dependencies -->';

/**
 * Update the single bot-owned dependency compatibility issue, preserving maintainer notes.
 * // Usage: await reportFreshDependencies({ github, context, revision, runUrl });
 */
export async function reportFreshDependencies({ github, context, revision, runUrl }) {
  if (!/^[a-f0-9]{40}$/.test(revision)) {
    throw new Error(
      `Invalid revision ${JSON.stringify(revision)}; expected a 40-character Git SHA`
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
    `[Workflow logs and resolved lockfile](${runUrl})`,
    '',
    'This scheduled check resolves compatible dependencies independently of the committed lockfile. Exact SDK pins remain exact. Inspect the failing command and resolved lockfile before proposing a dependency change.',
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
