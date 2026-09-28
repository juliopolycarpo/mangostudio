import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PREVIEW_MARKER } from '../../lib/changelog';
import { type CommitEntry, renderCommitsSection } from '../commit-log';
import { QA_METRICS_MARKER as TS_METRICS_MARKER } from '../render/document';
import {
  composeCommitsReport,
  renderChangelogForComment,
  QA_COMMITS_MARKER as TS_COMMITS_MARKER,
} from '../report-document';
import {
  COMMITS_FALLBACK_BODY,
  endsWithMarkerLine,
  fetchCurrentHeadSha,
  isManagedComment,
  LEGACY_MARKERS,
  METRICS_FALLBACK_BODY,
  publishQaComments,
  QA_COMMITS_MARKER,
  QA_METRICS_MARKER,
  readReportBody,
} from './managed-comments.mjs';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface FakeComment {
  readonly id: number;
  body: string;
  readonly user: { readonly type: string };
}

/**
 * In-memory stand-in for the Octokit surface the publisher touches. Records
 * every write and delete in order so the tests can assert the update-or-create
 * lifecycle, per-marker duplicate cleanup, and that legacy deletion trails
 * both replacement writes. `failWritesEndingWith` rejects only the writes whose
 * body ends with that marker, so one comment can fail while the other succeeds.
 */
class FakeGithubClient {
  comments: FakeComment[];
  headSha: string;
  failWritesEndingWith: string | null;
  deletedIds: number[] = [];
  createdBodies: string[] = [];
  updates: Array<{ id: number; body: string }> = [];
  /** Ordered `write:<marker>` / `delete:<id>` log across every call. */
  events: string[] = [];
  private nextId = 1000;

  constructor(
    comments: FakeComment[],
    headSha: string,
    failWritesEndingWith: string | null = null
  ) {
    this.comments = [...comments];
    this.headSha = headSha;
    this.failWritesEndingWith = failWritesEndingWith;
  }

  private writeFails(body: string): boolean {
    return this.failWritesEndingWith !== null && body.endsWith(this.failWritesEndingWith);
  }

  readonly rest = {
    pulls: {
      get: () => Promise.resolve({ data: { head: { sha: this.headSha } } }),
    },
    issues: {
      listComments: 'list-comments-route',
      deleteComment: ({ comment_id }: { comment_id: number }) => {
        this.events.push(`delete:${comment_id}`);
        this.deletedIds.push(comment_id);
        this.comments = this.comments.filter((comment) => comment.id !== comment_id);
        return Promise.resolve();
      },
      updateComment: ({ comment_id, body }: { comment_id: number; body: string }) => {
        if (this.writeFails(body)) return Promise.reject(new Error(`update failed: ${comment_id}`));
        this.events.push(`write:${body.split('\n').pop()}`);
        this.updates.push({ id: comment_id, body });
        const target = this.comments.find((comment) => comment.id === comment_id);
        if (target) target.body = body;
        return Promise.resolve();
      },
      createComment: ({ body }: { body: string }) => {
        if (this.writeFails(body)) return Promise.reject(new Error('create failed'));
        this.events.push(`write:${body.split('\n').pop()}`);
        this.createdBodies.push(body);
        const comment = { id: this.nextId++, body, user: { type: 'Bot' } };
        this.comments.push(comment);
        return Promise.resolve({ data: comment });
      },
    },
  };

  paginate = (route: unknown) => {
    expect(route).toBe(this.rest.issues.listComments);
    return Promise.resolve([...this.comments]);
  };

  /** Comments whose body ends with `marker`, in PR order. */
  withMarker(marker: string): FakeComment[] {
    return this.comments.filter((comment) => endsWithMarkerLine(comment.body, marker));
  }
}

/** Captures core.notice calls emitted on skipped publishes. */
class FakeCore {
  notices: string[] = [];
  notice = (message: string) => {
    this.notices.push(message);
  };
}

const context = { repo: { owner: 'mango', repo: 'studio' } };

const bot = (id: number, marker: string): FakeComment => ({
  id,
  body: `stale\n${marker}`,
  user: { type: 'Bot' },
});

const human = (id: number): FakeComment => ({
  id,
  body: 'just my opinion',
  user: { type: 'User' },
});

const unrelatedBot = (id: number): FakeComment => ({
  id,
  body: 'coverage: 91%\n<!-- codecov-comment -->',
  user: { type: 'Bot' },
});

const METRICS_BODY = `fresh metrics\n${QA_METRICS_MARKER}`;
const COMMITS_BODY = `fresh commits\n${QA_COMMITS_MARKER}`;
const LEGACY_COMBINED_MARKER = '<!-- qa-gate-comment -->';
const LEGACY_COMMITS_MARKER = '<!-- pr-commits-comment -->';

const publishOptions = {
  pullNumber: 7,
  expectedHeadSha: 'head-sha',
  metricsBody: METRICS_BODY,
  commitsBody: COMMITS_BODY,
};

const publish = (github: FakeGithubClient, overrides: Partial<typeof publishOptions> = {}) =>
  publishQaComments({ github, context, core: new FakeCore() }, { ...publishOptions, ...overrides });

describe('managed comment markers', () => {
  it('stays in sync with the TypeScript renderers', () => {
    expect(QA_METRICS_MARKER).toBe(TS_METRICS_MARKER);
    expect(QA_COMMITS_MARKER).toBe(TS_COMMITS_MARKER);
    expect(LEGACY_MARKERS).toEqual([LEGACY_COMBINED_MARKER, LEGACY_COMMITS_MARKER, PREVIEW_MARKER]);
  });

  it('keeps the two live markers distinct from each other and from every legacy marker', () => {
    const all = [QA_METRICS_MARKER, QA_COMMITS_MARKER, ...LEGACY_MARKERS];
    expect(new Set(all).size).toBe(all.length);
  });
});

const ALL_TEST_MARKERS = [QA_METRICS_MARKER, QA_COMMITS_MARKER, ...LEGACY_MARKERS];

describe('endsWithMarkerLine', () => {
  it('requires the marker alone on the last non-empty line', () => {
    expect(endsWithMarkerLine(`body\n${QA_METRICS_MARKER}`, QA_METRICS_MARKER)).toBe(true);
    expect(endsWithMarkerLine(`body\r\n  ${QA_METRICS_MARKER}  \n\n`, QA_METRICS_MARKER)).toBe(
      true
    );
    expect(endsWithMarkerLine(QA_METRICS_MARKER, QA_METRICS_MARKER)).toBe(true);
  });

  it('rejects a marker that only ends a line of prose or is not last', () => {
    expect(endsWithMarkerLine(`quoting ${QA_METRICS_MARKER}`, QA_METRICS_MARKER)).toBe(false);
    expect(endsWithMarkerLine(`${QA_METRICS_MARKER}\ntrailing`, QA_METRICS_MARKER)).toBe(false);
    expect(endsWithMarkerLine(`body\n${QA_COMMITS_MARKER}`, QA_METRICS_MARKER)).toBe(false);
  });
});

describe('isManagedComment', () => {
  it('matches bot comments ending with a live or legacy marker', () => {
    expect(isManagedComment(bot(1, QA_METRICS_MARKER))).toBe(true);
    expect(isManagedComment(bot(2, QA_COMMITS_MARKER))).toBe(true);
    for (const marker of LEGACY_MARKERS) expect(isManagedComment(bot(3, marker))).toBe(true);
    expect(isManagedComment(human(4))).toBe(false);
    expect(isManagedComment(unrelatedBot(5))).toBe(false);
    expect(isManagedComment({ id: 6, body: QA_METRICS_MARKER, user: { type: 'User' } })).toBe(
      false
    );
    expect(isManagedComment({ id: 7, body: 'no marker', user: { type: 'Bot' } })).toBe(false);
    // Another bot whose last line merely ends with a quoted marker is not ours either.
    for (const marker of ALL_TEST_MARKERS) {
      expect(isManagedComment({ id: 9, body: `see ${marker}`, user: { type: 'Bot' } })).toBe(false);
    }
    // Another bot quoting a marker mid-body must never be deleted as ours.
    expect(
      isManagedComment({
        id: 8,
        body: `quoting ${QA_METRICS_MARKER} mid-body`,
        user: { type: 'Bot' },
      })
    ).toBe(false);
  });
});

describe('publishQaComments', () => {
  it('creates both comments, metrics first, when none exist yet', async () => {
    const github = new FakeGithubClient([human(2)], 'head-sha');

    expect(await publish(github)).toBe(true);

    expect(github.createdBodies).toEqual([METRICS_BODY, COMMITS_BODY]);
    expect(github.updates).toEqual([]);
    expect(github.deletedIds).toEqual([]);
  });

  it('updates each comment in place, dedupes per marker, and leaves others untouched', async () => {
    const github = new FakeGithubClient(
      [
        bot(1, QA_METRICS_MARKER),
        human(2),
        bot(3, QA_COMMITS_MARKER),
        unrelatedBot(4),
        bot(5, QA_METRICS_MARKER),
        bot(6, QA_COMMITS_MARKER),
      ],
      'head-sha'
    );

    expect(await publish(github)).toBe(true);

    expect(github.updates).toEqual([
      { id: 5, body: METRICS_BODY },
      { id: 6, body: COMMITS_BODY },
    ]);
    expect(github.createdBodies).toEqual([]);
    // Only same-marker duplicates go; the sibling comment survives the first write.
    expect(github.deletedIds.sort((a, b) => a - b)).toEqual([1, 3]);
    expect(github.comments.map((comment) => comment.id)).toEqual([2, 4, 5, 6]);
  });

  it('deletes the retired combined and standalone comments only after both replacements are written', async () => {
    const github = new FakeGithubClient(
      [
        human(1),
        bot(2, LEGACY_COMBINED_MARKER),
        bot(3, LEGACY_COMMITS_MARKER),
        bot(4, PREVIEW_MARKER),
        unrelatedBot(5),
      ],
      'head-sha'
    );

    expect(await publish(github)).toBe(true);

    expect(github.events).toEqual([
      `write:${QA_METRICS_MARKER}`,
      `write:${QA_COMMITS_MARKER}`,
      'delete:2',
      'delete:3',
      'delete:4',
    ]);
    // Humans and unrelated bots are untouched; exactly one of each managed comment remains.
    expect(github.comments.map((comment) => comment.id)).toEqual([1, 5, 1000, 1001]);
    expect(github.withMarker(QA_METRICS_MARKER)).toHaveLength(1);
    expect(github.withMarker(QA_COMMITS_MARKER)).toHaveLength(1);
  });

  it('keeps the legacy comments and still publishes commits when the metrics write fails', async () => {
    const github = new FakeGithubClient(
      [bot(2, LEGACY_COMBINED_MARKER), bot(3, LEGACY_COMMITS_MARKER)],
      'head-sha',
      QA_METRICS_MARKER
    );

    await expect(publish(github)).rejects.toThrow('create failed');

    expect(github.createdBodies).toEqual([COMMITS_BODY]);
    expect(github.deletedIds).toEqual([]);
    expect(github.comments.map((comment) => comment.id)).toEqual([2, 3, 1000]);
  });

  it('keeps the legacy comments and still publishes metrics when the commits write fails', async () => {
    const github = new FakeGithubClient(
      [bot(2, LEGACY_COMBINED_MARKER), bot(4, QA_COMMITS_MARKER)],
      'head-sha',
      QA_COMMITS_MARKER
    );

    await expect(publish(github)).rejects.toThrow('update failed: 4');

    expect(github.createdBodies).toEqual([METRICS_BODY]);
    expect(github.updates).toEqual([]);
    expect(github.deletedIds).toEqual([]);
    expect(github.comments.map((comment) => comment.id)).toEqual([2, 4, 1000]);
  });

  it('reports both errors and deletes nothing when both writes fail', async () => {
    const github = new FakeGithubClient([bot(2, LEGACY_COMBINED_MARKER)], 'head-sha', '-->');

    const error = await publish(github).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toHaveLength(2);
    expect((error as AggregateError).message).toContain('both QA comments failed to publish');
    expect(github.deletedIds).toEqual([]);
  });

  it('skips publishing when the PR head moved past the expected sha', async () => {
    const github = new FakeGithubClient([bot(1, QA_METRICS_MARKER)], 'newer-sha');
    const core = new FakeCore();

    const published = await publishQaComments(
      { github, context, core },
      { ...publishOptions, expectedHeadSha: 'old-sha' }
    );

    expect(published).toBe(false);
    expect(github.events).toEqual([]);
    expect(core.notices).toHaveLength(1);
  });

  it.each([
    [
      'metricsBody',
      'no marker here',
      'QA metrics comment body must end with <!-- qa-gate-metrics-comment --> on its own last line',
    ],
    [
      'commitsBody',
      METRICS_BODY,
      'QA commits comment body must end with <!-- qa-gate-commits-comment --> on its own last line',
    ],
  ])(
    'rejects a %s that does not end with its own marker before writing anything',
    async (field, body, message) => {
      const github = new FakeGithubClient([], 'head-sha');

      await expect(publish(github, { [field]: body })).rejects.toThrow(message);

      expect(github.events).toEqual([]);
    }
  );

  it('converges to exactly one of each comment across reruns', async () => {
    const github = new FakeGithubClient([], 'head-sha');

    await publish(github);
    await publish(github);

    expect(github.createdBodies).toHaveLength(2);
    expect(github.updates).toHaveLength(2);
    expect(github.withMarker(QA_METRICS_MARKER)).toHaveLength(1);
    expect(github.withMarker(QA_COMMITS_MARKER)).toHaveLength(1);
    expect(github.comments.filter(isManagedComment)).toHaveLength(2);
  });

  it('converges after a partial failure is retried, then removes the legacy comment', async () => {
    const github = new FakeGithubClient([bot(2, LEGACY_COMBINED_MARKER)], 'head-sha');

    github.failWritesEndingWith = QA_COMMITS_MARKER;
    await expect(publish(github)).rejects.toThrow('create failed');
    expect(github.comments.map((comment) => comment.id)).toEqual([2, 1000]);

    github.failWritesEndingWith = null;
    expect(await publish(github)).toBe(true);

    expect(github.comments.map((comment) => comment.id)).toEqual([1000, 1001]);
    expect(github.withMarker(QA_METRICS_MARKER)).toHaveLength(1);
    expect(github.withMarker(QA_COMMITS_MARKER)).toHaveLength(1);
  });

  // The workflow renders each part in its own continue-on-error step and hands
  // the resulting files (or their absence) to readReportBody.
  it.each([
    ['QA render', 'metrics', 'commits'],
    ['commits render', 'commits', 'metrics'],
  ] as const)(
    'a failed %s still publishes the other comment',
    async (_label, failedKind, okKind) => {
      const dir = await mkdtemp(join(tmpdir(), 'mango-publish-'));
      tempDirs.push(dir);
      const markers = { metrics: QA_METRICS_MARKER, commits: QA_COMMITS_MARKER };
      await writeFile(
        join(dir, `${okKind}.md`),
        `real ${okKind} body\n${markers[okKind]}\n`,
        'utf8'
      );
      const bodies = {
        metrics: await readReportBody(join(dir, 'metrics.md'), 'metrics'),
        commits: await readReportBody(join(dir, 'commits.md'), 'commits'),
      };
      const github = new FakeGithubClient([bot(2, LEGACY_COMBINED_MARKER)], 'head-sha');

      await publish(github, { metricsBody: bodies.metrics, commitsBody: bodies.commits });

      const fallbacks = { metrics: METRICS_FALLBACK_BODY, commits: COMMITS_FALLBACK_BODY };
      expect(github.withMarker(markers[failedKind])[0]?.body).toBe(fallbacks[failedKind]);
      expect(github.withMarker(markers[okKind])[0]?.body).toBe(
        `real ${okKind} body\n${markers[okKind]}`
      );
      expect(github.withMarker(markers.metrics)).toHaveLength(1);
      expect(github.withMarker(markers.commits)).toHaveLength(1);
      expect(github.withMarker(LEGACY_COMBINED_MARKER)).toHaveLength(0);
    }
  );

  // Commit subjects and changelog lines are untrusted text that lands in the
  // commits comment; a marker inside them must neither forge nor hide one.
  it.each(ALL_TEST_MARKERS)(
    'a commit subject and changelog line containing %s leave exactly one of each comment and delete nothing else',
    async (hostileMarker) => {
      const hostileSubject = `fix: handle ${hostileMarker} & <b>html</b>`;
      const entries: CommitEntry[] = Array.from({ length: 7 }, (_, index) => ({
        sha: `${index + 1}`.padStart(7, '0') + 'a'.repeat(33),
        subject: index === 6 ? hostileSubject : `feat: commit ${index}`,
        message:
          index === 6 ? `${hostileSubject}\n\nbody ${hostileMarker}` : `feat: commit ${index}`,
      }));
      const commitsBody = composeCommitsReport({
        commits: renderCommitsSection(entries, {
          baseSha: 'b'.repeat(40),
          headSha: 'c'.repeat(40),
        }),
        changelog: renderChangelogForComment(
          `### Fixes\n\n- ${hostileSubject}\n- ${hostileMarker}\n`
        ),
      });
      const bystanders = [
        human(1),
        unrelatedBot(2),
        { id: 3, body: `mentions ${hostileMarker}`, user: { type: 'Bot' } },
        { id: 4, body: `see ${hostileMarker}`, user: { type: 'Bot' } },
      ];
      const github = new FakeGithubClient(
        [...bystanders, bot(5, QA_METRICS_MARKER), bot(6, QA_COMMITS_MARKER)],
        'head-sha'
      );

      await publish(github, { commitsBody });
      await publish(github, { commitsBody });

      expect(github.deletedIds).toEqual([]);
      expect(github.comments.map((comment) => comment.id)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(github.withMarker(QA_METRICS_MARKER)).toHaveLength(1);
      expect(github.withMarker(QA_COMMITS_MARKER)).toHaveLength(1);
      // Outside the fenced full message, no raw HTML comment survives in the body.
      const outsideFences = commitsBody.replace(/(`{4,})text[\s\S]*?\1/g, '');
      expect(outsideFences.match(/<!--/g)).toHaveLength(1);
      expect(outsideFences).toContain('&lt;!--');
    }
  );

  it('heals pre-existing duplicates of both comments in one run', async () => {
    const github = new FakeGithubClient(
      [
        bot(1, QA_METRICS_MARKER),
        bot(2, QA_COMMITS_MARKER),
        bot(3, QA_METRICS_MARKER),
        bot(4, QA_COMMITS_MARKER),
      ],
      'head-sha'
    );

    await publish(github);

    expect(github.comments.map((comment) => comment.id)).toEqual([3, 4]);
  });
});

describe('readReportBody', () => {
  const writeReport = async (name: string, content: string): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), 'mango-publish-'));
    tempDirs.push(dir);
    const path = join(dir, name);
    await writeFile(path, content, 'utf8');
    return path;
  };

  it('returns the file content when it ends with the marker of its kind', async () => {
    const metrics = await writeReport('metrics.md', `rendered\n${QA_METRICS_MARKER}\n`);
    const commits = await writeReport('commits.md', `rendered\n${QA_COMMITS_MARKER}\n`);

    expect(await readReportBody(metrics, 'metrics')).toBe(`rendered\n${QA_METRICS_MARKER}`);
    expect(await readReportBody(commits, 'commits')).toBe(`rendered\n${QA_COMMITS_MARKER}`);
  });

  it('falls back per kind for missing files, marker-less content, and the wrong marker', async () => {
    const markerless = await writeReport('markerless.md', 'partial output, render crashed midway');
    const wrongKind = await writeReport('commits.md', `commits\n${QA_COMMITS_MARKER}`);

    expect(await readReportBody('/nonexistent/metrics.md', 'metrics')).toBe(METRICS_FALLBACK_BODY);
    expect(await readReportBody(markerless, 'metrics')).toBe(METRICS_FALLBACK_BODY);
    expect(await readReportBody(markerless, 'commits')).toBe(COMMITS_FALLBACK_BODY);
    expect(await readReportBody(wrongKind, 'metrics')).toBe(METRICS_FALLBACK_BODY);
    expect(METRICS_FALLBACK_BODY.endsWith(QA_METRICS_MARKER)).toBe(true);
    expect(COMMITS_FALLBACK_BODY.endsWith(QA_COMMITS_MARKER)).toBe(true);
  });

  it('names the invalid kind and the expected ones', async () => {
    await expect(readReportBody('x.md', 'combined')).rejects.toThrow(
      'unknown report kind "combined"; expected one of metrics, commits'
    );
  });
});

describe('fetchCurrentHeadSha', () => {
  it('returns the live PR head sha', async () => {
    const github = new FakeGithubClient([], 'live-sha');
    expect(await fetchCurrentHeadSha(github, context, 7)).toBe('live-sha');
  });
});
