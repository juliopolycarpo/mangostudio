// Publisher for the consolidated PR QA report comment. Plain ESM JavaScript so
// actions/github-script (node) can `await import()` it directly, while bun
// tests exercise the same module. The marker literal is duplicated from the
// TypeScript renderer on purpose (node cannot import the .ts sources); the
// unit test pins both sides together.

import { readFile } from 'node:fs/promises';

/** Marker for the consolidated QA report comment (update-or-create target). */
export const QA_REPORT_MARKER = '<!-- qa-gate-comment -->';

/**
 * Markers of the retired standalone comments (commit summary and changelog
 * preview, now sections of the consolidated report). Recognized only so old
 * comments are cleaned up once per PR after this pipeline lands.
 */
export const LEGACY_MARKERS = Object.freeze([
  '<!-- pr-commits-comment -->',
  '<!-- changelog-preview-comment -->',
]);

const ALL_MARKERS = Object.freeze([QA_REPORT_MARKER, ...LEGACY_MARKERS]);

/** Fallback body published when the report failed to render. */
export const REPORT_FALLBACK_BODY = [
  '## PR QA Report',
  '',
  '_The QA report failed to render for this run; see the workflow logs._',
  '',
  QA_REPORT_MARKER,
].join('\n');

function managedMarkerForComment(comment) {
  if (comment?.user?.type !== 'Bot' || typeof comment.body !== 'string') return null;
  const body = comment.body.trimEnd();
  return ALL_MARKERS.find((marker) => body.endsWith(marker)) ?? null;
}

/**
 * True when a PR comment is one of ours: bot-authored and ending in a marker.
 * Anchoring at the end keeps another bot that merely quotes a marker mid-body
 * from being treated (and deleted) as ours; the report body always ends with
 * its marker, enforced by publishQaReport.
 * // Usage: comments.filter(isManagedComment)
 */
export function isManagedComment(comment) {
  return managedMarkerForComment(comment) !== null;
}

/**
 * Read the rendered report body, falling back when the renderer failed.
 * Missing, empty, or marker-less files publish REPORT_FALLBACK_BODY so a
 * renderer crash still produces a comment pointing at the logs.
 * // Usage: await readReportBody('report.md')
 */
export async function readReportBody(path) {
  try {
    const text = (await readFile(path, 'utf8')).trim();
    if (text.endsWith(QA_REPORT_MARKER)) return text;
  } catch {
    // Missing file: the render step failed; the fallback below covers it.
  }
  return REPORT_FALLBACK_BODY;
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
 * Update the consolidated QA report comment in place (or create it once).
 *
 * Re-checks the PR head immediately before writing so a stale run can never
 * overwrite a newer run's report. The newest existing report comment is the
 * update target; duplicates from older runs and the retired standalone
 * comments (LEGACY_MARKERS) are deleted only after the write succeeds, so a
 * mid-publish failure never leaves the PR without a report.
 *
 * // Usage: await publishQaReport({ github, context, core }, { pullNumber, expectedHeadSha, body })
 */
export async function publishQaReport(
  { github, context, core },
  { pullNumber, expectedHeadSha, body }
) {
  if (!body.trimEnd().endsWith(QA_REPORT_MARKER)) {
    throw new Error('QA report body must end with its marker');
  }

  const currentHeadSha = await fetchCurrentHeadSha(github, context, pullNumber);
  if (currentHeadSha !== expectedHeadSha) {
    core.notice(
      `Skipping QA report publish: PR head moved from ${expectedHeadSha} to ${currentHeadSha}.`
    );
    return false;
  }

  const managed = await listManagedComments(github, context, pullNumber);
  const reportComments = managed.filter(({ marker }) => marker === QA_REPORT_MARKER);
  const target = reportComments[reportComments.length - 1] ?? null;

  let keptId;
  if (target) {
    await github.rest.issues.updateComment({
      ...context.repo,
      comment_id: target.comment.id,
      body,
    });
    keptId = target.comment.id;
  } else {
    const { data } = await github.rest.issues.createComment({
      ...context.repo,
      issue_number: pullNumber,
      body,
    });
    keptId = data.id;
  }

  for (const { comment } of managed) {
    if (comment.id === keptId) continue;
    await github.rest.issues.deleteComment({ ...context.repo, comment_id: comment.id });
  }
  return true;
}
