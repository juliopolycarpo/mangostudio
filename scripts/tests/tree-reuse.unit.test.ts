import { describe, expect, test } from 'bun:test';

import { renderTreeReuseSummary } from '../ci/tree-reuse';
import {
  COMPARE_FILE_LIMIT,
  resolveTreeReuse,
  TREE_REUSE_SKIPPABLE_JOBS,
  type TreeReuseApi,
  type TreeReuseDeps,
  type TreeReuseVerdict,
} from '../lib/tree-reuse';
import { readText } from './support/read-text';
import { extractJobBlock, extractStepBlock, extractStepBlocks } from './support/workflow-blocks';

// Built apart so the linter does not read the workflow expression opener as a template string.
const EXPR = '$' + '{{';
const REPOSITORY = 'owner/repo';
const SHA = 'a'.repeat(40);
const BEFORE = 'b'.repeat(40);
const PR_HEAD = 'c'.repeat(40);
const MERGE = 'd'.repeat(40);
const TREE = 'e'.repeat(40);
const OTHER = 'f'.repeat(40);
const RUN_ID = 4242;
const PR_NUMBER = 77;
const NOW = Date.parse('2026-11-28T12:00:00Z');
const INPUT = { repository: REPOSITORY, sha: SHA, before: BEFORE };
const DEPS: TreeReuseDeps = { now: () => NOW, skippableJobs: ['Smoke / one', 'Smoke / two'] };

/** Everything the resolver reads, keyed the way a test mutates it. */
interface World {
  pushCommit: Record<string, unknown>;
  compare: Record<string, unknown>;
  pulls: unknown;
  runs: Record<string, unknown>[];
  mergeCommit: Record<string, unknown>;
  jobs: Record<string, unknown>[];
}

function commitPayload(parents: string[], tree: string): Record<string, unknown> {
  return { parents: parents.map((sha) => ({ sha })), commit: { tree: { sha: tree } } };
}

function job(name: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name,
    run_id: RUN_ID,
    run_attempt: 1,
    status: 'completed',
    conclusion: 'success',
    ...overrides,
  };
}

function acceptedWorld(): World {
  return {
    pushCommit: commitPayload([BEFORE], TREE),
    compare: { total_commits: 1, files: [{ filename: 'apps/api/src/index.ts' }] },
    pulls: [
      {
        number: PR_NUMBER,
        merged_at: '2026-11-28T11:00:00Z',
        merge_commit_sha: SHA,
        base: { ref: 'main' },
        head: { sha: PR_HEAD, repo: { full_name: REPOSITORY } },
        user: { login: 'maintainer', type: 'User' },
      },
    ],
    runs: [
      {
        id: RUN_ID,
        run_number: 10,
        run_attempt: 1,
        event: 'pull_request',
        head_sha: PR_HEAD,
        status: 'completed',
        conclusion: 'success',
        path: '.github/workflows/ci.yml',
        updated_at: '2026-11-28T11:30:00Z',
        repository: { full_name: REPOSITORY },
        head_repository: { full_name: REPOSITORY },
        referenced_workflows: [
          {
            path: `${REPOSITORY}/.github/workflows/test.yml@${MERGE}`,
            ref: `refs/pull/${PR_NUMBER}/merge`,
            sha: MERGE,
          },
          {
            path: `${REPOSITORY}/.github/workflows/build.yml@${MERGE}`,
            ref: `refs/pull/${PR_NUMBER}/merge`,
            sha: MERGE,
          },
        ],
      },
    ],
    mergeCommit: commitPayload([BEFORE, PR_HEAD], TREE),
    jobs: [
      job('CI Gate'),
      job('Smoke / one'),
      job('Smoke / two'),
      job('Unrelated', { conclusion: 'failure' }),
    ],
  };
}

/** Named fake of the GitHub read port: serves one `World`, records every read, can fail a path. */
class FakeTreeReuseApi implements TreeReuseApi {
  readonly reads: string[] = [];

  constructor(
    private readonly world: World,
    private readonly failingPathFragment?: string
  ) {}

  get(path: string): unknown {
    this.reads.push(`GET ${path}`);
    this.failIfRequested(path);
    if (path === `repos/${REPOSITORY}/commits/${SHA}`) return this.world.pushCommit;
    if (path === `repos/${REPOSITORY}/commits/${SHA}/pulls`) return this.world.pulls;
    if (path === `repos/${REPOSITORY}/compare/${BEFORE}...${SHA}`) return this.world.compare;
    if (path === `repos/${REPOSITORY}/commits/${MERGE}`) return this.world.mergeCommit;
    throw new Error(`FakeTreeReuseApi: no GET response for ${path}`);
  }

  list(path: string, key: string): readonly unknown[] {
    this.reads.push(`LIST ${path}`);
    this.failIfRequested(path);
    if (
      path.includes('/actions/workflows/ci.yml/runs?event=pull_request') &&
      key === 'workflow_runs'
    ) {
      return this.world.runs;
    }
    if (path.includes(`/actions/runs/${RUN_ID}/jobs`) && key === 'jobs') return this.world.jobs;
    throw new Error(`FakeTreeReuseApi: no LIST response for ${path} (${key})`);
  }

  private failIfRequested(path: string): void {
    if (this.failingPathFragment !== undefined && path.includes(this.failingPathFragment)) {
      throw new Error(`GitHub API GET ${path}: expected successful gh exit 0 | received: exit 1`);
    }
  }
}

function resolve(
  mutate: (world: World) => void = () => {},
  options: { deps?: TreeReuseDeps; failingPathFragment?: string } = {}
): { verdict: TreeReuseVerdict; api: FakeTreeReuseApi } {
  const world = acceptedWorld();
  mutate(world);
  const api = new FakeTreeReuseApi(world, options.failingPathFragment);
  return { verdict: resolveTreeReuse(api, INPUT, options.deps ?? DEPS), api };
}

function rejection(
  mutate: (world: World) => void,
  options: { deps?: TreeReuseDeps; failingPathFragment?: string } = {}
): string {
  const { verdict } = resolve(mutate, options);
  if (verdict.reuse)
    throw new Error('tree-reuse test: expected reuse: false | received: reuse: true');
  return verdict.reason;
}

function firstPull(world: World): Record<string, unknown> {
  return (world.pulls as Record<string, unknown>[])[0] as Record<string, unknown>;
}

describe('resolveTreeReuse accepts', () => {
  test('a squash merge whose tested merge commit has the same tree', () => {
    const { verdict } = resolve();
    expect(verdict).toEqual({ reuse: true, runId: RUN_ID, mergeCommit: MERGE, tree: TREE });
  });

  test('the newest run by run number, not the first listed', () => {
    const { verdict } = resolve((world) => {
      const older = {
        ...(world.runs[0] as Record<string, unknown>),
        id: 1,
        run_number: 3,
        conclusion: 'failure',
      };
      world.runs = [older, ...world.runs];
    });
    expect(verdict).toMatchObject({ reuse: true, runId: RUN_ID });
  });
});

describe('check 1: single push parent', () => {
  test('two parents', () => {
    const reason = rejection((world) => {
      world.pushCommit = commitPayload([BEFORE, OTHER], TREE);
    });
    expect(reason).toContain('single-parent push commit');
    expect(reason).toContain(`exactly one parent equal to before ${BEFORE}`);
    expect(reason).toContain(OTHER);
  });

  test('one parent that is not before', () => {
    const reason = rejection((world) => {
      world.pushCommit = commitPayload([OTHER], TREE);
    });
    expect(reason).toContain(`received ["${OTHER}"]`);
  });
});

describe('check 2: merged same-repository human pull request', () => {
  test('two pull requests', () => {
    const reason = rejection((world) => {
      world.pulls = [firstPull(world), firstPull(world)];
    });
    expect(reason).toContain('pull request count');
    expect(reason).toContain('expected exactly one pull request; received 2');
  });

  test('no pull request', () => {
    expect(rejection((world) => (world.pulls = []))).toContain(
      'expected exactly one pull request; received 0'
    );
  });

  test('not merged', () => {
    expect(rejection((world) => (firstPull(world).merged_at = null))).toContain(
      'merged_at: expected a merge timestamp'
    );
  });

  test('merge_commit_sha is another commit', () => {
    const reason = rejection((world) => (firstPull(world).merge_commit_sha = OTHER));
    expect(reason).toContain(`expected the push commit ${SHA}; received "${OTHER}"`);
  });

  test('base is not main', () => {
    const reason = rejection((world) => (firstPull(world).base = { ref: 'stack/x' }));
    expect(reason).toContain('base ref: expected main; received "stack/x"');
  });

  test('fork pull request', () => {
    const reason = rejection((world) => {
      firstPull(world).head = { sha: PR_HEAD, repo: { full_name: 'someone/repo' } };
    });
    expect(reason).toContain(
      'expected this repository owner/repo (not a fork); received "someone/repo"'
    );
  });

  test('deleted head repository', () => {
    const reason = rejection((world) => {
      firstPull(world).head = { sha: PR_HEAD, repo: null };
    });
    expect(reason).toContain('received null');
  });

  test('bot author by type', () => {
    const reason = rejection(
      (world) => (firstPull(world).user = { login: 'renovate', type: 'Bot' })
    );
    expect(reason).toContain('expected a non-bot account; received "renovate (Bot)"');
  });

  test('bot author by login suffix', () => {
    const reason = rejection(
      (world) => (firstPull(world).user = { login: 'dependabot[bot]', type: 'User' })
    );
    expect(reason).toContain('dependabot[bot]');
  });
});

describe('check 3: newest pull request run', () => {
  test('no run for the head', () => {
    expect(rejection((world) => (world.runs = []))).toContain(
      'expected at least one run; received "none"'
    );
  });

  test('a newer failed run hides an older success', () => {
    const reason = rejection((world) => {
      world.runs.push({
        ...(world.runs[0] as Record<string, unknown>),
        id: 9,
        run_number: 11,
        conclusion: 'failure',
      });
    });
    expect(reason).toContain(
      'expected completed and success; received {"status":"completed","conclusion":"failure"}'
    );
  });

  test('still running', () => {
    const reason = rejection((world) => {
      Object.assign(world.runs[0] as Record<string, unknown>, {
        status: 'in_progress',
        conclusion: null,
      });
    });
    expect(reason).toContain('received {"status":"in_progress","conclusion":null}');
  });

  test('run attempt 2', () => {
    const reason = rejection(
      (world) => ((world.runs[0] as Record<string, unknown>).run_attempt = 2)
    );
    expect(reason).toContain(
      'run_attempt: expected 1 (a re-run may have mixed attempts); received 2'
    );
  });

  test('another workflow path', () => {
    const reason = rejection((world) => {
      (world.runs[0] as Record<string, unknown>).path = '.github/workflows/other.yml';
    });
    expect(reason).toContain(
      'expected .github/workflows/ci.yml; received ".github/workflows/other.yml"'
    );
  });

  test('a head repository that is a fork', () => {
    const reason = rejection((world) => {
      (world.runs[0] as Record<string, unknown>).head_repository = { full_name: 'someone/repo' };
    });
    expect(reason).toContain('head_repository: expected owner/repo; received "someone/repo"');
  });

  test('older than 24 hours', () => {
    const reason = rejection((world) => {
      (world.runs[0] as Record<string, unknown>).updated_at = '2026-11-27T11:59:00Z';
    });
    expect(reason).toContain(
      'expected finished within the last 24 hours; received "1441 minutes ago"'
    );
  });

  test('exactly 24 hours old still counts', () => {
    const { verdict } = resolve((world) => {
      (world.runs[0] as Record<string, unknown>).updated_at = '2026-11-27T12:00:00Z';
    });
    expect(verdict.reuse).toBe(true);
  });

  test('a finish time far in the future', () => {
    const reason = rejection((world) => {
      (world.runs[0] as Record<string, unknown>).updated_at = '2026-11-28T13:00:00Z';
    });
    expect(reason).toContain('received "-60 minutes ago"');
  });

  test('an unparseable finish time', () => {
    const reason = rejection(
      (world) => ((world.runs[0] as Record<string, unknown>).updated_at = 'yesterday')
    );
    expect(reason).toContain('expected an ISO timestamp; received "yesterday"');
  });
});

describe('check 4: referenced workflows', () => {
  test('empty list', () => {
    const reason = rejection(
      (world) => ((world.runs[0] as Record<string, unknown>).referenced_workflows = [])
    );
    expect(reason).toContain('referenced_workflows: expected a non-empty array; received []');
  });

  test('missing field', () => {
    const reason = rejection(
      (world) => delete (world.runs[0] as Record<string, unknown>).referenced_workflows
    );
    expect(reason).toContain('expected array; received undefined');
  });

  test('two distinct referenced SHAs', () => {
    const reason = rejection((world) => {
      const entries = (world.runs[0] as Record<string, unknown>).referenced_workflows as Record<
        string,
        unknown
      >[];
      (entries[1] as Record<string, unknown>).sha = OTHER;
    });
    expect(reason).toContain('expected one and the same commit');
    expect(reason).toContain(OTHER);
  });

  test('an entry on another ref', () => {
    const reason = rejection((world) => {
      const entries = (world.runs[0] as Record<string, unknown>).referenced_workflows as Record<
        string,
        unknown
      >[];
      (entries[0] as Record<string, unknown>).ref = 'refs/heads/main';
    });
    expect(reason).toContain(`expected refs/pull/${PR_NUMBER}/merge; received "refs/heads/main"`);
  });

  test('an entry without a commit SHA', () => {
    const reason = rejection((world) => {
      const entries = (world.runs[0] as Record<string, unknown>).referenced_workflows as Record<
        string,
        unknown
      >[];
      (entries[0] as Record<string, unknown>).sha = 'main';
    });
    expect(reason).toContain('expected 40-character lowercase hex commit SHA; received "main"');
  });
});

describe('check 5: tested merge commit', () => {
  test('M with other parents', () => {
    const reason = rejection(
      (world) => (world.mergeCommit = commitPayload([OTHER, PR_HEAD], TREE))
    );
    expect(reason).toContain(`expected [before ${BEFORE}, pull request head ${PR_HEAD}]`);
    expect(reason).toContain(OTHER);
  });

  test('M with the right parents in the wrong order', () => {
    const reason = rejection(
      (world) => (world.mergeCommit = commitPayload([PR_HEAD, BEFORE], TREE))
    );
    expect(reason).toContain('merge commit');
  });

  test('tree mismatch', () => {
    const reason = rejection(
      (world) => (world.mergeCommit = commitPayload([BEFORE, PR_HEAD], OTHER))
    );
    expect(reason).toContain(`expected push commit tree ${TREE}; received "${OTHER}"`);
  });
});

describe('check 6: jobs', () => {
  test('a skipped job in the list', () => {
    const reason = rejection((world) => {
      world.jobs[1] = job('Smoke / one', { conclusion: 'skipped' });
    });
    expect(reason).toContain('job "Smoke / one"');
    expect(reason).toContain(
      'expected completed, success and 4242; received {"status":"completed","conclusion":"skipped","run_id":4242}'
    );
  });

  test('CI Gate failed', () => {
    const reason = rejection((world) => {
      world.jobs[0] = job('CI Gate', { conclusion: 'failure' });
    });
    expect(reason).toContain('job "CI Gate"');
  });

  test('a listed job missing from the run', () => {
    const reason = rejection(
      (world) => (world.jobs = world.jobs.filter((entry) => entry.name !== 'Smoke / two'))
    );
    expect(reason).toContain(
      'job "Smoke / two": expected a job with that name; received "no such job"'
    );
  });

  test('only the latest attempt counts', () => {
    const { verdict } = resolve((world) => {
      world.jobs.push(job('Smoke / one', { run_attempt: 2 }));
      world.jobs[1] = job('Smoke / one', { conclusion: 'failure' });
    });
    expect(verdict.reuse).toBe(true);
    const { verdict: later } = resolve((world) => {
      world.jobs.push(job('Smoke / one', { run_attempt: 2, conclusion: 'failure' }));
    });
    expect(later.reuse).toBe(false);
  });

  test('two jobs at the latest attempt', () => {
    const reason = rejection((world) => world.jobs.push(job('CI Gate')));
    expect(reason).toContain('expected one job per attempt');
  });

  test('a job of another run', () => {
    const reason = rejection((world) => (world.jobs[0] = job('CI Gate', { run_id: 1 })));
    expect(reason).toContain('"run_id":1}');
  });

  test('the default list names the Browser Smoke jobs', () => {
    expect(TREE_REUSE_SKIPPABLE_JOBS).toEqual([
      'Smoke — Browser / Chromium smoke suite',
      'Smoke — Browser / Production frontend regressions',
    ]);
  });
});

describe('check 7: diff scope', () => {
  test.each([
    '.github/workflows/ci.yml',
    'scripts/ci/evaluate-gate.ts',
    'scripts/lib/tree-reuse.ts',
  ])('a change to %s', (path) => {
    const reason = rejection(
      (world) => (world.compare.files = [{ filename: 'README.md' }, { filename: path }])
    );
    expect(reason).toContain('diff scope');
    expect(reason).toContain(`received "${path}"`);
  });

  test('a rename out of a guarded path', () => {
    const reason = rejection((world) => {
      world.compare.files = [
        { filename: 'docs/ci.yml', previous_filename: '.github/workflows/ci.yml' },
      ];
    });
    expect(reason).toContain('received ".github/workflows/ci.yml"');
  });

  test('similarly named paths outside the guard pass', () => {
    const { verdict } = resolve((world) => {
      world.compare.files = [
        { filename: 'scripts/lib/tree-reuse-notes.md' },
        { filename: 'docs/.github/x.md' },
      ];
    });
    expect(verdict.reuse).toBe(true);
  });

  test('a truncated compare', () => {
    const reason = rejection((world) => {
      world.compare.files = Array.from({ length: COMPARE_FILE_LIMIT }, (_, index) => ({
        filename: `src/f${index}.ts`,
      }));
    });
    expect(reason).toContain(
      'expected fewer than 300 entries (the API truncates there); received "300 entries"'
    );
  });

  test('one file below the limit is read in full', () => {
    const { verdict } = resolve((world) => {
      world.compare.files = Array.from({ length: COMPARE_FILE_LIMIT - 1 }, (_, index) => ({
        filename: `src/f${index}.ts`,
      }));
    });
    expect(verdict.reuse).toBe(true);
  });

  test('a compare that spans more than the push commit', () => {
    const reason = rejection((world) => (world.compare.total_commits = 2));
    expect(reason).toContain('expected exactly the one push commit (1); received 2');
  });

  test('a compare without a file list', () => {
    const reason = rejection((world) => delete world.compare.files);
    expect(reason).toContain('compare files: expected array; received undefined');
  });
});

describe('read failures and malformed payloads never throw', () => {
  test.each([
    ['push commit', `commits/${SHA}`],
    ['compare', '/compare/'],
    ['pull requests', '/pulls'],
    ['runs', '/actions/workflows/ci.yml/runs'],
    ['merge commit', `commits/${MERGE}`],
    ['jobs', `/actions/runs/${RUN_ID}/jobs`],
  ])('a failed %s read is a reason', (_label, fragment) => {
    const { verdict } = resolve(() => {}, { failingPathFragment: fragment });
    expect(verdict.reuse).toBe(false);
    if (!verdict.reuse) expect(verdict.reason).toContain('expected successful gh exit 0');
  });

  test('a payload of the wrong type', () => {
    const reason = rejection(
      (world) => (world.pushCommit = 'not json' as unknown as Record<string, unknown>)
    );
    expect(reason).toContain('Invalid commit');
    expect(reason).toContain('expected object; received "not json"');
  });

  test.each([
    ['repository', { ...INPUT, repository: '' }],
    ['push sha', { ...INPUT, sha: 'abc' }],
    ['before sha', { ...INPUT, before: '' }],
  ])('a bad %s input names the value and reads nothing', (label, input) => {
    const api = new FakeTreeReuseApi(acceptedWorld());
    const verdict = resolveTreeReuse(api, input, DEPS);
    expect(verdict.reuse).toBe(false);
    if (!verdict.reuse) expect(verdict.reason).toContain(`input: Invalid ${label}`);
    expect(api.reads).toEqual([]);
  });

  test('reads stop at the first refusal', () => {
    const { api } = resolve((world) => (world.pushCommit = commitPayload([OTHER], TREE)));
    expect(api.reads).toEqual([`GET repos/${REPOSITORY}/commits/${SHA}`]);
  });
});

describe('renderTreeReuseSummary', () => {
  const context = { repository: REPOSITORY, sha: SHA, serverUrl: 'https://github.com' };

  test('links the proven run and names the tree', () => {
    const text = renderTreeReuseSummary(
      { reuse: true, runId: RUN_ID, mergeCommit: MERGE, tree: TREE },
      context
    );
    expect(text).toContain('this run skipped nothing');
    expect(text).toContain(`https://github.com/owner/repo/actions/runs/${RUN_ID}`);
    expect(text).toContain(TREE);
    expect(text).toContain(MERGE);
  });

  test('gives the reason of a full run', () => {
    const text = renderTreeReuseSummary(
      { reuse: false, reason: 'diff scope: touched .github/' },
      context
    );
    expect(text).toContain('Verdict: **full run**');
    expect(text).toContain('Reason: diff scope: touched .github/');
  });
});

describe('ci.yml shadow step policy', () => {
  const workflow = readText('.github/workflows/ci.yml');
  const preflight = extractJobBlock(workflow, 'changes');
  const SHADOW = 'Compute the tree reuse shadow verdict';
  const step = extractStepBlock(preflight, SHADOW);

  test('the step runs only for a main push and can neither fail nor outlast a minute', () => {
    expect(step).toContain(
      `if: ${EXPR} github.event_name == 'push' && github.ref == 'refs/heads/main' }}`
    );
    expect(step).toContain('continue-on-error: true');
    expect(step).toContain('timeout-minutes: 1');
    expect(step).toContain('run: bun ./scripts/ci/tree-reuse.ts');
    expect(step).not.toMatch(/^ {8}id:/m);
    // The only step in the whole workflow that names the script.
    expect(workflow.match(/scripts\/ci\/tree-reuse\.ts/g)).toHaveLength(1);
  });

  test('no step or job reads an output of the shadow step', () => {
    // The step has no `id`, so `steps.<id>.outputs` cannot name it; the script
    // writes only to the summary and the log.
    expect(step).not.toContain('GITHUB_OUTPUT');
    expect(readText('scripts/ci/tree-reuse.ts')).not.toContain('GITHUB_OUTPUT');
    const withIds = extractStepBlocks(preflight).filter((block) =>
      /^ {6}- id:|^ {8}id:/m.test(block)
    );
    for (const block of withIds) {
      expect(block, 'a step with an id must not be the shadow step').not.toContain('tree-reuse');
    }
    for (const reference of workflow.matchAll(/steps\.([\w-]+)\.outputs/g)) {
      expect(
        reference[1],
        `steps.${reference[1]}.outputs must not name the shadow step`
      ).not.toMatch(/tree|reuse|shadow/);
    }
    expect(workflow).not.toMatch(
      /needs\.changes\.outputs\.(?:\w*reuse\w*|\w*tree\w*|\w*shadow\w*)/
    );
    expect(preflight).not.toMatch(/^ {6}[\w_]*(?:reuse|shadow)[\w_]*: \$\{\{/m);
  });

  test('the job grants only the two extra reads and keeps the settle environment', () => {
    expect(preflight).toContain(
      "permissions:\n      contents: read\n      actions: read # tree-reuse shadow: the merged pull request's CI run and its jobs\n      pull-requests: read # the PR's labels (lane set); the pushed commit's pull requests"
    );
    expect(preflight).toContain(
      `name: ${EXPR} github.event_name == 'push' && 'main-ci-settle' || '' }}`
    );
  });
});
