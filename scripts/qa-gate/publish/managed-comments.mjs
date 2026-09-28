// Publisher for the two managed PR QA comments: QA metrics, and commits plus
// changelog preview. Plain ESM JavaScript so actions/github-script (node) can
// `await import()` it directly, while bun tests exercise the same module. The
// marker literals are duplicated from the TypeScript renderers on purpose (node
// cannot import the .ts sources); the unit test pins both sides together.

import { readFile } from 'node:fs/promises';

/** Marker for the QA metrics comment (update-or-create target). */
export const QA_METRICS_MARKER = '<!-- qa-gate-metrics-comment -->';

/** Marker for the commits + changelog preview comment (update-or-create target). */
export const QA_COMMITS_MARKER = '<!-- qa-gate-commits-comment -->';

/**
 * Markers of retired comments: the combined QA report that carried metrics,
 * commits, and changelog in one body, plus the older standalone commit summary
 * and changelog preview. Recognized only so they are cleaned up, and only once
 * both replacement comments are written.
 */
export const LEGACY_MARKERS = Object.freeze([
  '<!-- qa-gate-comment -->',
  '<!-- pr-commits-comment -->',
  '<!-- changelog-preview-comment -->',
]);

const ALL_MARKERS = Object.freeze([QA_METRICS_MARKER, QA_COMMITS_MARKER, ...LEGACY_MARKERS]);

/** Fallback body published when the QA metrics failed to render. */
export const METRICS_FALLBACK_BODY = [
  '## PR QA Report',
  '',
  '_The QA report failed to render for this run; see the workflow logs._',
  '',
  QA_METRICS_MARKER,
].join('\n');

/** Fallback body published when the commits + changelog failed to render. */
export const COMMITS_FALLBACK_BODY = [
  '## Commits and changelog',
  '',
  '_The commit summary and changelog preview failed to render for this run; see the workflow logs._',
  '',
  QA_COMMITS_MARKER,
].join('\n');

const REPORTS = Object.freeze({
  metrics: { marker: QA_METRICS_MARKER, fallback: METRICS_FALLBACK_BODY },
  commits: { marker: QA_COMMITS_MARKER, fallback: COMMITS_FALLBACK_BODY },
});

function managedMarkerForComment(comment) {
  if (comment?.user?.type !== 'Bot' || typeof comment.body !== 'string') return null;
  const body = comment.body.trimEnd();
  return ALL_MARKERS.find((marker) => body.endsWith(marker)) ?? null;
}

/**
 * True when a PR comment is one of ours: bot-authored and ending in a marker.
 * Anchoring at the end keeps another bot that merely quotes a marker mid-body
 * from being treated (and deleted) as ours; every body always ends with its
 * marker, enforced by publishQaComments.
 * // Usage: comments.filter(isManagedComment)
 */
export function isManagedComment(comment) {
  return managedMarkerForComment(comment) !== null;
}

/**
 * Read a rendered comment body, falling back when its renderer failed.
 * Missing, empty, or marker-less files publish that comment's fallback body so
 * a renderer crash still produces a comment pointing at the logs, without
 * affecting the other comment.
 * // Usage: await readReportBody('metrics.md', 'metrics')
 */
export async function readReportBody(path, kind) {
  const report = REPORTS[kind];
  if (!report) {
    throw new Error(
      `unknown report kind ${JSON.stringify(kind)}; expected one of ${Object.keys(REPORTS).join(', ')}`
    );
  }
  try {
    const text = (await readFile(path, 'utf8')).trim();
    if (text.endsWith(report.marker)) return text;
  } catch {
    // Missing file: the render step failed; the fallback below covers it.
  }
  return report.fallback;
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

async function upsertComment({ github, context }, { pullNumber, marker, body, managed }) {
  const existing = managed.filter((entry) => entry.marker === marker);
  const target = existing[existing.length - 1] ?? null;

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

  // Duplicates of this marker only: the sibling comment and legacy comments
  // are not this write's to remove.
  for (const { comment } of existing) {
    if (comment.id === keptId) continue;
    await github.rest.issues.deleteComment({ ...context.repo, comment_id: comment.id });
  }
}

/**
 * Publish the QA metrics comment and the commits + changelog comment, each
 * updated in place by its own marker (or created once).
 *
 * Re-checks the PR head before writing so a stale run can never overwrite a
 * newer run's comments. The two writes are independent: one failing never
 * prevents the other. Legacy comments (LEGACY_MARKERS, including the retired
 * combined report) are deleted only when both writes succeeded, so a
 * mid-publish failure never leaves the PR without its commit or QA
 * information. Any write error is rethrown after the other write was tried.
 *
 * // Usage: await publishQaComments({ github, context, core }, { pullNumber, expectedHeadSha, metricsBody, commitsBody })
 */
export async function publishQaComments(
  { github, context, core },
  { pullNumber, expectedHeadSha, metricsBody, commitsBody }
) {
  const writes = [
    { name: 'metrics', marker: QA_METRICS_MARKER, body: metricsBody },
    { name: 'commits', marker: QA_COMMITS_MARKER, body: commitsBody },
  ];
  for (const { name, marker, body } of writes) {
    if (typeof body !== 'string' || !body.trimEnd().endsWith(marker)) {
      throw new Error(`QA ${name} comment body must end with its marker ${marker}`);
    }
  }

  const currentHeadSha = await fetchCurrentHeadSha(github, context, pullNumber);
  if (currentHeadSha !== expectedHeadSha) {
    core.notice(
      `Skipping QA comments publish: PR head moved from ${expectedHeadSha} to ${currentHeadSha}.`
    );
    return false;
  }

  const managed = await listManagedComments(github, context, pullNumber);
  const errors = [];
  for (const { marker, body } of writes) {
    try {
      await upsertComment({ github, context }, { pullNumber, marker, body, managed });
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(
      errors,
      `both QA comments failed to publish: ${errors.map((error) => error?.message ?? error).join('; ')}`
    );
  }

  for (const { comment, marker } of managed) {
    if (!LEGACY_MARKERS.includes(marker)) continue;
    await github.rest.issues.deleteComment({ ...context.repo, comment_id: comment.id });
  }
  return true;
}
