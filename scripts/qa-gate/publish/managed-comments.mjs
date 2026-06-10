// Publisher for the automation-managed PR comments. Plain ESM JavaScript so
// actions/github-script (node) can `await import()` it directly, while bun
// tests exercise the same module. Marker literals are duplicated from the
// TypeScript renderers on purpose (node cannot import the .ts sources); the
// unit test pins both sides together.

import { readFile } from 'node:fs/promises';

/** Marker for the commit-summary bot comment. */
export const COMMITS_MARKER = '<!-- pr-commits-comment -->';
/** Marker for the changelog-preview bot comment. */
export const CHANGELOG_PREVIEW_MARKER = '<!-- changelog-preview-comment -->';
/** Marker for the QA-gate metrics bot comment. */
export const QA_GATE_MARKER = '<!-- qa-gate-comment -->';

/** Display order of the managed comments, top to bottom. */
export const MANAGED_MARKER_ORDER = Object.freeze([
  COMMITS_MARKER,
  CHANGELOG_PREVIEW_MARKER,
  QA_GATE_MARKER,
]);

/**
 * True when a PR comment is one of ours: bot-authored and carrying a marker.
 * // Usage: comments.filter(isManagedComment)
 */
export function isManagedComment(comment) {
  if (comment?.user?.type !== 'Bot' || typeof comment.body !== 'string') return false;
  return MANAGED_MARKER_ORDER.some((marker) => comment.body.includes(marker));
}

/**
 * Placeholder QA-gate body shown while metrics collect; replaced on publish.
 * // Usage: renderQaPendingBody({ headSha, runUrl })
 */
export function renderQaPendingBody({ headSha, runUrl }) {
  const shortSha = typeof headSha === 'string' ? headSha.slice(0, 7) : 'unknown';
  return [
    '## QA Gate — Running',
    '',
    `Collecting coverage, bundle, dependency, test, and tooling metrics for \`${shortSha}\`.`,
    'This comment is replaced with the full base→head comparison when the run completes (usually a few minutes).',
    '',
    `[Watch the run](${runUrl})`,
    '',
    QA_GATE_MARKER,
  ].join('\n');
}

/**
 * Read a rendered comment body, falling back when the renderer failed.
 *
 * The workflow renders bodies with continue-on-error so one broken renderer
 * cannot strand the pending placeholder; this substitutes a marked fallback
 * for missing, empty, or marker-less files.
 *
 * // Usage: await readCommentBody('commits.md', { marker, fallback: '_Commit summary failed to render._' })
 */
export async function readCommentBody(path, { marker, fallback }) {
  try {
    const text = (await readFile(path, 'utf8')).trim();
    if (text.includes(marker)) return text;
  } catch {
    // Missing file: the render step failed; the fallback below covers it.
  }
  return [fallback, '', marker].join('\n');
}

/**
 * Resolve the PR's current head SHA so stale runs can detect they lost the race.
 * // Usage: await fetchCurrentHeadSha(github, context, prNumber)
 */
export async function fetchCurrentHeadSha(github, context, pullNumber) {
  const { data } = await github.rest.pulls.get({
    ...context.repo,
    pull_number: pullNumber,
  });
  return data.head.sha;
}

/**
 * Delete every managed comment, then recreate the given bodies in order.
 *
 * Refuses to publish when the PR head moved past `expectedHeadSha`, so an
 * older run can never overwrite a newer run's comments. Sequential creates
 * make the final discussion order deterministic. Idempotent: re-running with
 * the same inputs converges to the same comment set.
 *
 * // Usage: await publishManagedComments({ github, context, core }, { pullNumber, expectedHeadSha, comments: [{ marker, body }] })
 */
export async function publishManagedComments(
  { github, context, core },
  { pullNumber, expectedHeadSha, comments }
) {
  for (const { marker, body } of comments) {
    if (!MANAGED_MARKER_ORDER.includes(marker)) {
      throw new Error(`Unknown managed comment marker: ${marker}`);
    }
    if (!body.includes(marker)) {
      throw new Error(`Comment body for ${marker} is missing its marker`);
    }
  }
  const ordered = [...comments].sort(
    (a, b) => MANAGED_MARKER_ORDER.indexOf(a.marker) - MANAGED_MARKER_ORDER.indexOf(b.marker)
  );

  const currentHeadSha = await fetchCurrentHeadSha(github, context, pullNumber);
  if (currentHeadSha !== expectedHeadSha) {
    core.notice(
      `Skipping comment publish: PR head moved from ${expectedHeadSha} to ${currentHeadSha}.`
    );
    return false;
  }

  const existing = await github.paginate(github.rest.issues.listComments, {
    ...context.repo,
    issue_number: pullNumber,
    per_page: 100,
  });
  for (const comment of existing.filter(isManagedComment)) {
    await github.rest.issues.deleteComment({ ...context.repo, comment_id: comment.id });
  }

  for (const { body } of ordered) {
    await github.rest.issues.createComment({
      ...context.repo,
      issue_number: pullNumber,
      body,
    });
  }
  return true;
}
