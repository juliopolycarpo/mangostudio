import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PREVIEW_MARKER } from '../../lib/changelog';
import { COMMENT_MARKER } from '../render/document';
import {
  fetchCurrentHeadSha,
  isManagedComment,
  LEGACY_MARKERS,
  publishQaReport,
  QA_REPORT_MARKER,
  REPORT_FALLBACK_BODY,
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
 * In-memory stand-in for the Octokit surface the publisher touches. Captures
 * updates, creates, and deletes so the tests can assert the update-or-create
 * lifecycle and the legacy/duplicate cleanup.
 */
class FakeGithubClient {
  comments: FakeComment[];
  headSha: string;
  deletedIds: number[] = [];
  createdBodies: string[] = [];
  updates: Array<{ id: number; body: string }> = [];
  private nextId = 1000;

  constructor(
    comments: FakeComment[],
    headSha: string,
    private readonly failWrites = false
  ) {
    this.comments = [...comments];
    this.headSha = headSha;
  }

  readonly rest = {
    pulls: {
      get: () => Promise.resolve({ data: { head: { sha: this.headSha } } }),
    },
    issues: {
      listComments: 'list-comments-route',
      deleteComment: ({ comment_id }: { comment_id: number }) => {
        this.deletedIds.push(comment_id);
        this.comments = this.comments.filter((comment) => comment.id !== comment_id);
        return Promise.resolve();
      },
      updateComment: ({ comment_id, body }: { comment_id: number; body: string }) => {
        if (this.failWrites) return Promise.reject(new Error('update failed'));
        this.updates.push({ id: comment_id, body });
        const target = this.comments.find((comment) => comment.id === comment_id);
        if (target) target.body = body;
        return Promise.resolve();
      },
      createComment: ({ body }: { body: string }) => {
        if (this.failWrites) return Promise.reject(new Error('create failed'));
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

const REPORT_BODY = `fresh report\n${QA_REPORT_MARKER}`;
const LEGACY_COMMITS_MARKER = '<!-- pr-commits-comment -->';

describe('managed comment markers', () => {
  it('stays in sync with the TypeScript renderers', () => {
    expect(QA_REPORT_MARKER).toBe(COMMENT_MARKER);
    expect(LEGACY_MARKERS).toEqual([LEGACY_COMMITS_MARKER, PREVIEW_MARKER]);
  });
});

describe('isManagedComment', () => {
  it('matches bot comments ending with the report or a legacy marker', () => {
    expect(isManagedComment(bot(1, QA_REPORT_MARKER))).toBe(true);
    expect(isManagedComment(bot(2, LEGACY_COMMITS_MARKER))).toBe(true);
    expect(isManagedComment(bot(3, PREVIEW_MARKER))).toBe(true);
    expect(isManagedComment(human(4))).toBe(false);
    expect(isManagedComment({ id: 5, body: QA_REPORT_MARKER, user: { type: 'User' } })).toBe(false);
    expect(isManagedComment({ id: 6, body: 'no marker', user: { type: 'Bot' } })).toBe(false);
    // Another bot quoting a marker mid-body must never be deleted as ours.
    expect(
      isManagedComment({
        id: 7,
        body: `quoting ${QA_REPORT_MARKER} mid-body`,
        user: { type: 'Bot' },
      })
    ).toBe(false);
  });
});

describe('publishQaReport', () => {
  it('updates the newest report comment in place and cleans up duplicates and legacy comments', async () => {
    const github = new FakeGithubClient(
      [
        bot(1, QA_REPORT_MARKER),
        human(2),
        bot(3, PREVIEW_MARKER),
        bot(4, LEGACY_COMMITS_MARKER),
        bot(5, QA_REPORT_MARKER),
      ],
      'head-sha'
    );
    const core = new FakeCore();

    const published = await publishQaReport(
      { github, context, core },
      { pullNumber: 7, expectedHeadSha: 'head-sha', body: REPORT_BODY }
    );

    expect(published).toBe(true);
    expect(github.updates).toEqual([{ id: 5, body: REPORT_BODY }]);
    expect(github.createdBodies).toEqual([]);
    expect(github.deletedIds.sort((a, b) => a - b)).toEqual([1, 3, 4]);
    expect(github.comments.map((comment) => comment.body.split('\n')[0])).toEqual([
      'just my opinion',
      'fresh report',
    ]);
    expect(core.notices).toEqual([]);
  });

  it('creates the report comment when none exists yet', async () => {
    const github = new FakeGithubClient([human(2)], 'head-sha');
    const core = new FakeCore();

    const published = await publishQaReport(
      { github, context, core },
      { pullNumber: 7, expectedHeadSha: 'head-sha', body: REPORT_BODY }
    );

    expect(published).toBe(true);
    expect(github.createdBodies).toEqual([REPORT_BODY]);
    expect(github.updates).toEqual([]);
    expect(github.deletedIds).toEqual([]);
  });

  it('skips publishing when the PR head moved past the expected sha', async () => {
    const github = new FakeGithubClient([bot(1, QA_REPORT_MARKER)], 'newer-sha');
    const core = new FakeCore();

    const published = await publishQaReport(
      { github, context, core },
      { pullNumber: 7, expectedHeadSha: 'old-sha', body: REPORT_BODY }
    );

    expect(published).toBe(false);
    expect(github.deletedIds).toEqual([]);
    expect(github.updates).toEqual([]);
    expect(github.createdBodies).toEqual([]);
    expect(core.notices).toHaveLength(1);
  });

  it('keeps every existing comment when the write fails', async () => {
    const github = new FakeGithubClient(
      [bot(1, QA_REPORT_MARKER), bot(3, PREVIEW_MARKER)],
      'head-sha',
      true
    );
    const core = new FakeCore();

    await expect(
      publishQaReport(
        { github, context, core },
        { pullNumber: 7, expectedHeadSha: 'head-sha', body: REPORT_BODY }
      )
    ).rejects.toThrow('update failed');

    expect(github.deletedIds).toEqual([]);
    expect(github.comments.map((comment) => comment.id)).toEqual([1, 3]);
  });

  it('rejects bodies not ending with the report marker', async () => {
    const github = new FakeGithubClient([], 'head-sha');
    const core = new FakeCore();

    await expect(
      publishQaReport(
        { github, context, core },
        { pullNumber: 7, expectedHeadSha: 'head-sha', body: 'no marker here' }
      )
    ).rejects.toThrow('must end with its marker');
  });

  it('converges to exactly one report comment across reruns', async () => {
    const github = new FakeGithubClient([], 'head-sha');
    const core = new FakeCore();
    const options = { pullNumber: 7, expectedHeadSha: 'head-sha', body: REPORT_BODY };

    await publishQaReport({ github, context, core }, options);
    await publishQaReport({ github, context, core }, options);

    expect(github.createdBodies).toHaveLength(1);
    expect(github.updates).toHaveLength(1);
    expect(github.comments.filter(isManagedComment)).toHaveLength(1);
  });
});

describe('readReportBody', () => {
  it('returns the file content when it ends with the marker', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mango-publish-'));
    tempDirs.push(dir);
    const path = join(dir, 'report.md');
    await writeFile(path, `rendered body\n${QA_REPORT_MARKER}\n`, 'utf8');

    expect(await readReportBody(path)).toBe(`rendered body\n${QA_REPORT_MARKER}`);
  });

  it('falls back for missing files and marker-less content', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mango-publish-'));
    tempDirs.push(dir);
    const markerless = join(dir, 'markerless.md');
    await writeFile(markerless, 'partial output, render crashed midway', 'utf8');

    expect(await readReportBody(join(dir, 'absent.md'))).toBe(REPORT_FALLBACK_BODY);
    expect(await readReportBody(markerless)).toBe(REPORT_FALLBACK_BODY);
    expect(REPORT_FALLBACK_BODY.endsWith(QA_REPORT_MARKER)).toBe(true);
  });
});

describe('fetchCurrentHeadSha', () => {
  it('returns the live PR head sha', async () => {
    const github = new FakeGithubClient([], 'live-sha');
    expect(await fetchCurrentHeadSha(github, context, 7)).toBe('live-sha');
  });
});
