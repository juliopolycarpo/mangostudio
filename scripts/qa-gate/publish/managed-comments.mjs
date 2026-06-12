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

/** Fallback body per marker, published when its renderer produced no output. */
export const MANAGED_FALLBACKS = Object.freeze({
  [COMMITS_MARKER]: '## Commits\n\n_Commit summary failed to render for this run._',
  [CHANGELOG_PREVIEW_MARKER]:
    '## 📝 Changelog Preview\n\n_Changelog preview failed to render for this run._',
  [QA_GATE_MARKER]:
    '## QA Gate\n\n_QA metrics failed to render for this run; see the workflow logs._',
});

/**
 * True when a PR comment is one of ours: bot-authored and ending in a marker.
 * Anchoring at the end keeps another bot that merely quotes a marker mid-body
 * from being treated (and deleted) as ours; every managed body ends with its
 * marker, enforced by publishManagedComments.
 * // Usage: comments.filter(isManagedComment)
 */
export function isManagedComment(comment) {
  return managedMarkerForComment(comment) !== null;
}

function managedMarkerForComment(comment) {
  if (comment?.user?.type !== 'Bot' || typeof comment.body !== 'string') return null;
  const body = comment.body.trimEnd();
  return MANAGED_MARKER_ORDER.find((marker) => body.endsWith(marker)) ?? null;
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
 * cannot strand the pending placeholder; this substitutes the marker's
 * fallback from MANAGED_FALLBACKS for missing, empty, or marker-less files.
 *
 * // Usage: await readCommentBody('commits.md', COMMITS_MARKER)
 */
export async function readCommentBody(path, marker) {
  const fallback = MANAGED_FALLBACKS[marker];
  if (!fallback) throw new Error(`Unknown managed comment marker: ${marker}`);
  try {
    const text = (await readFile(path, 'utf8')).trim();
    if (text.endsWith(marker)) return text;
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

function orderedManagedComments(comments) {
  const seen = new Set();
  for (const { marker, body } of comments) {
    if (!MANAGED_MARKER_ORDER.includes(marker)) {
      throw new Error(`Unknown managed comment marker: ${marker}`);
    }
    if (seen.has(marker)) {
      throw new Error(`Duplicate managed comment marker: ${marker}`);
    }
    seen.add(marker);
    if (!body.trimEnd().endsWith(marker)) {
      throw new Error(`Comment body for ${marker} must end with its marker`);
    }
  }
  return [...comments].sort(
    (a, b) => MANAGED_MARKER_ORDER.indexOf(a.marker) - MANAGED_MARKER_ORDER.indexOf(b.marker)
  );
}

async function listManagedComments(github, context, pullNumber) {
  const comments = await github.paginate(github.rest.issues.listComments, {
    ...context.repo,
    issue_number: pullNumber,
    per_page: 100,
  });
  return comments
    .map((comment) => ({ comment, marker: managedMarkerForComment(comment) }))
    .filter(({ marker }) => marker !== null);
}

/**
 * Re-post the managed comment set at the bottom of the PR timeline.
 *
 * Refuses to publish when the PR head moved past `expectedHeadSha`, so an
 * older run can never overwrite a newer run's comments. Comments are always
 * recreated instead of edited in place: GitHub keeps edited comments at their
 * original timeline position, which buries them above newly pushed commits.
 * The previous managed comments are deleted only after the new set is fully
 * created, so a mid-publish failure never leaves the PR without comments.
 *
 * // Usage: await publishManagedComments({ github, context, core }, { pullNumber, expectedHeadSha, comments: [{ marker, body }] })
 */
export async function publishManagedComments(
  { github, context, core },
  { pullNumber, expectedHeadSha, comments }
) {
  const ordered = orderedManagedComments(comments);
  const currentHeadSha = await fetchCurrentHeadSha(github, context, pullNumber);
  if (currentHeadSha !== expectedHeadSha) {
    core.notice(
      `Skipping comment publish: PR head moved from ${expectedHeadSha} to ${currentHeadSha}.`
    );
    return false;
  }

  const previous = await listManagedComments(github, context, pullNumber);

  for (const { body } of ordered) {
    await github.rest.issues.createComment({
      ...context.repo,
      issue_number: pullNumber,
      body,
    });
  }

  for (const { comment } of previous) {
    await github.rest.issues.deleteComment({ ...context.repo, comment_id: comment.id });
  }
  return true;
}
