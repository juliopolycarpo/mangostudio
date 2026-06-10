import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PREVIEW_MARKER } from '../../lib/changelog';
import { COMMITS_COMMENT_MARKER } from '../commit-log';
import { COMMENT_MARKER } from '../render/document';
import {
  CHANGELOG_PREVIEW_MARKER,
  COMMITS_MARKER,
  fetchCurrentHeadSha,
  isManagedComment,
  MANAGED_FALLBACKS,
  MANAGED_MARKER_ORDER,
  publishManagedComments,
  QA_GATE_MARKER,
  readCommentBody,
  renderQaPendingBody,
} from './managed-comments';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface FakeComment {
  readonly id: number;
  readonly body: string;
  readonly user: { readonly type: string };
}

/** In-memory stand-in for the Octokit surface the publisher touches. */
class FakeGithubClient {
  comments: FakeComment[];
  headSha: string;
  deletedIds: number[] = [];
  createdBodies: string[] = [];
  private nextId = 1000;

  constructor(
    comments: FakeComment[],
    headSha: string,
    private readonly failCreates = false
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
      createComment: ({ body }: { body: string }) => {
        if (this.failCreates) return Promise.reject(new Error('create failed'));
        this.createdBodies.push(body);
        this.comments.push({ id: this.nextId++, body, user: { type: 'Bot' } });
        return Promise.resolve();
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

const desiredComments = [
  { marker: QA_GATE_MARKER, body: `qa\n${QA_GATE_MARKER}` },
  { marker: COMMITS_MARKER, body: `commits\n${COMMITS_MARKER}` },
  { marker: CHANGELOG_PREVIEW_MARKER, body: `changelog\n${CHANGELOG_PREVIEW_MARKER}` },
];

describe('managed comment markers', () => {
  it('stays in sync with the TypeScript renderers', () => {
    expect(COMMITS_MARKER).toBe(COMMITS_COMMENT_MARKER);
    expect(CHANGELOG_PREVIEW_MARKER).toBe(PREVIEW_MARKER);
    expect(QA_GATE_MARKER).toBe(COMMENT_MARKER);
    expect(MANAGED_MARKER_ORDER).toEqual([
      COMMITS_MARKER,
      CHANGELOG_PREVIEW_MARKER,
      QA_GATE_MARKER,
    ]);
  });

  it('registers a fallback body for every managed marker', () => {
    expect(Object.keys(MANAGED_FALLBACKS).sort()).toEqual([...MANAGED_MARKER_ORDER].sort());
  });
});

describe('isManagedComment', () => {
  it('matches only bot comments ending with a managed marker', () => {
    expect(isManagedComment(bot(1, QA_GATE_MARKER))).toBe(true);
    expect(isManagedComment(human(2))).toBe(false);
    expect(isManagedComment({ id: 3, body: QA_GATE_MARKER, user: { type: 'User' } })).toBe(false);
    expect(isManagedComment({ id: 4, body: 'no marker', user: { type: 'Bot' } })).toBe(false);
    // Another bot quoting a marker mid-body must never be deleted as ours.
    expect(
      isManagedComment({
        id: 5,
        body: `quoting ${QA_GATE_MARKER} mid-body`,
        user: { type: 'Bot' },
      })
    ).toBe(false);
  });
});

describe('renderQaPendingBody', () => {
  it('includes the short sha, run link, and qa-gate marker', () => {
    const body = renderQaPendingBody({
      headSha: 'fedcba9876543210',
      runUrl: 'https://example.test/runs/1',
    });
    expect(body).toContain('`fedcba9`');
    expect(body).toContain('https://example.test/runs/1');
    expect(body.endsWith(QA_GATE_MARKER)).toBe(true);
  });
});

describe('publishManagedComments', () => {
  it('deletes stale managed comments and recreates bodies in fixed order', async () => {
    const github = new FakeGithubClient(
      [bot(1, QA_GATE_MARKER), human(2), bot(3, CHANGELOG_PREVIEW_MARKER), bot(4, COMMITS_MARKER)],
      'head-sha'
    );
    const core = new FakeCore();

    const published = await publishManagedComments(
      { github, context, core },
      { pullNumber: 7, expectedHeadSha: 'head-sha', comments: desiredComments }
    );

    expect(published).toBe(true);
    expect(github.deletedIds).toEqual([1, 3, 4]);
    expect(github.createdBodies.map((body) => body.split('\n')[0])).toEqual([
      'commits',
      'changelog',
      'qa',
    ]);
    expect(github.comments.filter((comment) => comment.user.type === 'User')).toHaveLength(1);
    expect(core.notices).toEqual([]);
  });

  it('skips publishing when the PR head moved past the expected sha', async () => {
    const github = new FakeGithubClient([bot(1, QA_GATE_MARKER)], 'newer-sha');
    const core = new FakeCore();

    const published = await publishManagedComments(
      { github, context, core },
      { pullNumber: 7, expectedHeadSha: 'old-sha', comments: desiredComments }
    );

    expect(published).toBe(false);
    expect(github.deletedIds).toEqual([]);
    expect(github.createdBodies).toEqual([]);
    expect(core.notices).toHaveLength(1);
  });

  it('is idempotent across reruns with the same inputs', async () => {
    const github = new FakeGithubClient([], 'head-sha');
    const core = new FakeCore();
    const options = { pullNumber: 7, expectedHeadSha: 'head-sha', comments: desiredComments };

    await publishManagedComments({ github, context, core }, options);
    await publishManagedComments({ github, context, core }, options);

    expect(github.comments.filter(isManagedComment)).toHaveLength(3);
    expect(github.comments.map((comment) => comment.body.split('\n')[0])).toEqual([
      'commits',
      'changelog',
      'qa',
    ]);
  });

  it('keeps the previous comments when a create fails mid-publish', async () => {
    const github = new FakeGithubClient([bot(1, QA_GATE_MARKER)], 'head-sha', true);
    const core = new FakeCore();

    await expect(
      publishManagedComments(
        { github, context, core },
        { pullNumber: 7, expectedHeadSha: 'head-sha', comments: desiredComments }
      )
    ).rejects.toThrow('create failed');

    expect(github.deletedIds).toEqual([]);
    expect(github.comments.map((comment) => comment.id)).toEqual([1]);
  });

  it('rejects bodies not ending with their marker and unknown markers', async () => {
    const github = new FakeGithubClient([], 'head-sha');
    const core = new FakeCore();

    await expect(
      publishManagedComments(
        { github, context, core },
        {
          pullNumber: 7,
          expectedHeadSha: 'head-sha',
          comments: [{ marker: QA_GATE_MARKER, body: 'no marker here' }],
        }
      )
    ).rejects.toThrow('must end with its marker');

    await expect(
      publishManagedComments(
        { github, context, core },
        {
          pullNumber: 7,
          expectedHeadSha: 'head-sha',
          comments: [{ marker: '<!-- rogue -->', body: '<!-- rogue -->' }],
        }
      )
    ).rejects.toThrow('Unknown managed comment marker');
  });

  it('rejects duplicate managed markers in one publish', async () => {
    const github = new FakeGithubClient([], 'head-sha');
    const core = new FakeCore();

    await expect(
      publishManagedComments(
        { github, context, core },
        {
          pullNumber: 7,
          expectedHeadSha: 'head-sha',
          comments: [
            { marker: QA_GATE_MARKER, body: `qa\n${QA_GATE_MARKER}` },
            { marker: QA_GATE_MARKER, body: `qa again\n${QA_GATE_MARKER}` },
          ],
        }
      )
    ).rejects.toThrow('Duplicate managed comment marker');
  });
});

describe('readCommentBody', () => {
  it('returns the file content when it ends with the marker', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mango-publish-'));
    tempDirs.push(dir);
    const path = join(dir, 'comment.md');
    await writeFile(path, `rendered body\n${QA_GATE_MARKER}\n`, 'utf8');

    expect(await readCommentBody(path, QA_GATE_MARKER)).toBe(`rendered body\n${QA_GATE_MARKER}`);
  });

  it('falls back for missing files and marker-less content', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mango-publish-'));
    tempDirs.push(dir);
    const markerless = join(dir, 'markerless.md');
    await writeFile(markerless, 'partial output, render crashed midway', 'utf8');
    const expected = [MANAGED_FALLBACKS[QA_GATE_MARKER], '', QA_GATE_MARKER].join('\n');

    expect(await readCommentBody(join(dir, 'absent.md'), QA_GATE_MARKER)).toBe(expected);
    expect(await readCommentBody(markerless, QA_GATE_MARKER)).toBe(expected);
  });

  it('rejects markers without a registered fallback', async () => {
    await expect(readCommentBody('whatever.md', '<!-- rogue -->')).rejects.toThrow(
      'Unknown managed comment marker'
    );
  });
});

describe('fetchCurrentHeadSha', () => {
  it('returns the live PR head sha', async () => {
    const github = new FakeGithubClient([], 'live-sha');
    expect(await fetchCurrentHeadSha(github, context, 7)).toBe('live-sha');
  });
});
