import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { evaluateGate, renderLightSummary } from '../ci/evaluate-gate';
import { renderOutputs, runLaneMode } from '../ci/lane-mode';
import { ROOT_DIR } from '../lib/config';
import {
  classifyDependabotDiff,
  classifyLaneMode,
  decideLaneMode,
  DEPENDABOT_LOGIN,
  type DependabotEcosystem,
  type FetchLike,
  FULL_RUN_LABEL,
  type LaneModeContext,
  LIGHT_REFUSAL,
  parseLaneSet,
  readPullRequestLabels,
} from '../lib/lane-mode';
import {
  LANE_SET_OS_MATRIX,
  LANE_SET_STEP_ENV,
  LANE_SET_STEP_RUN,
} from './support/lane-set-workflows';
import { readText } from './support/read-text';
import { useScratchDirs } from './support/scratch-dirs';
import {
  extractJobBlock,
  extractOnBlock,
  extractStepBlocks,
  parseNeedsList,
} from './support/workflow-blocks';

const EXPR = '$' + '{{';

const REPO = 'juliopolycarpo/mangostudio';

const DEPENDABOT_PR: LaneModeContext = {
  eventName: 'pull_request',
  author: DEPENDABOT_LOGIN,
  headRepo: REPO,
  baseRepo: REPO,
};

const BUN_DIFF = ['package.json', 'apps/api/package.json', 'bun.lock'];
const CARGO_DIFF = ['Cargo.lock', 'crates/mangostudio-runtime-cold/Cargo.toml'];
const ACTIONS_DIFF = [
  '.github/workflows/cargo-shim.yml',
  '.github/actions/setup-zigbuild/action.yml',
];

/** Records every read so a test can prove a decision never touched the API or the diff. */
class RecordingSourcesFake {
  labelReads = 0;
  pathReads = 0;
  constructor(
    private readonly labels: readonly string[] | Error,
    private readonly paths: readonly string[]
  ) {}
  readonly sources = {
    readLabels: (): Promise<readonly string[]> => {
      this.labelReads += 1;
      return this.labels instanceof Error
        ? Promise.reject(this.labels)
        : Promise.resolve(this.labels);
    },
    readPaths: (): readonly string[] => {
      this.pathReads += 1;
      return this.paths;
    },
  };
}

/** A scripted `GET /repos/{repo}/pulls/{n}` response; records the request it saw. */
class ScriptedPullApiFake {
  requests: Array<{ url: string; headers: Record<string, string> }> = [];
  constructor(private readonly reply: { status: number; body: unknown }) {}
  readonly fetchImpl: FetchLike = (url, init) => {
    this.requests.push({ url, headers: init.headers });
    return Promise.resolve({
      ok: this.reply.status >= 200 && this.reply.status < 300,
      status: this.reply.status,
      json: () => Promise.resolve(this.reply.body),
    });
  };
}

describe('classifyDependabotDiff: ecosystem from the changed paths', () => {
  test.each<[DependabotEcosystem, string[]]>([
    ['bun', BUN_DIFF],
    ['bun', ['apps/frontend/package.json', 'packages/protocol/package.json', 'bun.lock']],
    ['cargo', CARGO_DIFF],
    ['cargo', ['Cargo.toml', 'Cargo.lock', 'crates/mango-protocol/fuzz/Cargo.lock']],
    ['github-actions', ACTIONS_DIFF],
  ])('%s diff %p is eligible for the light set', (ecosystem, paths) => {
    expect(classifyDependabotDiff(paths)).toEqual({ ecosystem });
  });

  test('a path outside the manifests names itself and makes the diff full', () => {
    // PR #2052 carried a maintainer's fix to a policy test beside the lockfile.
    const verdict = classifyDependabotDiff([
      'bun.lock',
      'scripts/tests/dependency-policy.unit.test.ts',
    ]);
    expect(verdict).toEqual({
      reason:
        'diff touches scripts/tests/dependency-policy.unit.test.ts, which is not a dependency manifest: full lane set',
    });
  });

  test('a mixed-ecosystem diff is full and names the ecosystems', () => {
    expect(classifyDependabotDiff(['bun.lock', 'Cargo.lock'])).toEqual({
      reason: 'diff mixes bun, cargo: full lane set',
    });
  });

  test.each([['Dockerfile'], ['Dockerfile.alpine']])(
    'docker ecosystem file %s is full: the dropped lanes are its only validation',
    (path) => {
      const verdict = classifyDependabotDiff([path]);
      expect('reason' in verdict && verdict.reason).toContain('docker ecosystem');
    }
  );

  test.each([
    ['a source file named like a manifest', 'apps/api/src/package.json'],
    ['a nested workflow-like path', '.github/workflows/nested/ci.yml'],
    ['a crate source file', 'crates/mangostudio-runtime/src/lib.rs'],
    ['a Cargo manifest below a member', 'crates/mangostudio-runtime/examples/Cargo.toml'],
  ])('%s is not a dependency manifest', (_name, path) => {
    expect(classifyDependabotDiff([path])).toHaveProperty('reason');
  });
});

describe('classifyLaneMode: author x label x ecosystem', () => {
  const authors: Array<[string, string, 'light' | 'full']> = [
    ['dependabot[bot]', DEPENDABOT_LOGIN, 'light'],
    ['a human maintainer', 'juliopolycarpo', 'full'],
    ['a look-alike without the bot suffix', 'dependabot', 'full'],
    ['a different bot', 'dependabot-preview[bot]', 'full'],
    ['a case variant', 'Dependabot[bot]', 'full'],
    ['an empty author (push or dispatch payload)', '', 'full'],
  ];
  const labelSets: Array<[string, string[], 'light' | 'full']> = [
    ['no labels', [], 'light'],
    ['only the ecosystem label', ['type: dependencies'], 'light'],
    [`the ${FULL_RUN_LABEL} label`, [FULL_RUN_LABEL, 'type: dependencies'], 'full'],
    ['the label in another case', ['CI: Full'], 'full'],
  ];
  const diffs: Array<[string, string[], 'light' | 'full']> = [
    ['bun', BUN_DIFF, 'light'],
    ['cargo', CARGO_DIFF, 'light'],
    ['github-actions', ACTIONS_DIFF, 'light'],
    ['docker', ['Dockerfile'], 'full'],
    ['mixed', ['bun.lock', 'Cargo.lock'], 'full'],
    ['a maintainer fix on the branch', ['bun.lock', 'apps/api/src/index.ts'], 'full'],
  ];

  for (const [authorName, author, authorLane] of authors) {
    for (const [labelName, labels, labelLane] of labelSets) {
      for (const [diffName, paths, diffLane] of diffs) {
        const expected = [authorLane, labelLane, diffLane].every((lane) => lane === 'light')
          ? 'light'
          : 'full';
        test(`${authorName} + ${labelName} + ${diffName} diff -> ${expected}`, () => {
          const verdict = classifyLaneMode({ ...DEPENDABOT_PR, author }, labels, paths);
          expect(
            verdict.laneSet,
            `lane set for author=${author} labels=${labels.join('|')} paths=${paths.join('|')} | reason: ${verdict.reason}`
          ).toBe(expected);
        });
      }
    }
  }

  test('light reasons name the ecosystem and the label that would restore the full set', () => {
    expect(classifyLaneMode(DEPENDABOT_PR, [], CARGO_DIFF).reason).toBe(
      `Dependabot cargo manifest-only diff without the ${FULL_RUN_LABEL} label: light lane set`
    );
  });

  test.each([
    ['push', 'push'],
    ['workflow_dispatch', 'workflow_dispatch'],
    ['schedule', 'schedule'],
  ])('a %s event is never light, whatever the payload author says', (_name, eventName) => {
    const verdict = classifyLaneMode({ ...DEPENDABOT_PR, eventName }, [], BUN_DIFF);
    expect(verdict.laneSet).toBe('full');
    expect(verdict.reason).toContain('not a pull_request event');
  });

  test.each([
    ['a fork head', 'someone/mangostudio'],
    ['a missing head repository', ''],
  ])('%s is never light', (_name, headRepo) => {
    const verdict = classifyLaneMode({ ...DEPENDABOT_PR, headRepo }, [], BUN_DIFF);
    expect(verdict.laneSet).toBe('full');
    expect(verdict.reason).toContain('head repository');
  });
});

describe('decideLaneMode: what a decision reads', () => {
  test.each([
    ['a human author', { ...DEPENDABOT_PR, author: 'juliopolycarpo' }],
    ['a push event', { ...DEPENDABOT_PR, eventName: 'push' }],
    ['a fork head', { ...DEPENDABOT_PR, headRepo: 'someone/mangostudio' }],
  ])('%s decides full without reading labels or paths', async (_name, context) => {
    const fake = new RecordingSourcesFake(new Error('must not be read'), ['unreadable']);
    const verdict = await decideLaneMode(context, fake.sources);
    expect(verdict.laneSet).toBe('full');
    expect({ labelReads: fake.labelReads, pathReads: fake.pathReads }).toEqual({
      labelReads: 0,
      pathReads: 0,
    });
  });

  test('a Dependabot bump with fresh labels and a manifest diff is light', async () => {
    const fake = new RecordingSourcesFake(['type: dependencies'], CARGO_DIFF);
    expect((await decideLaneMode(DEPENDABOT_PR, fake.sources)).laneSet).toBe('light');
  });

  test('a label added after the event is seen through the run-time read', async () => {
    const fake = new RecordingSourcesFake(['type: dependencies', FULL_RUN_LABEL], BUN_DIFF);
    const verdict = await decideLaneMode(DEPENDABOT_PR, fake.sources);
    expect(verdict).toEqual({
      laneSet: 'full',
      reason: `${FULL_RUN_LABEL} label present: full lane set`,
    });
  });

  test('an unreadable label list falls back to full, naming the failure', async () => {
    const fake = new RecordingSourcesFake(new Error('GET pulls/1 responded 403'), BUN_DIFF);
    const verdict = await decideLaneMode(DEPENDABOT_PR, fake.sources);
    expect(verdict.laneSet).toBe('full');
    expect(verdict.reason).toContain('label read failed (GET pulls/1 responded 403)');
  });
});

describe('readPullRequestLabels', () => {
  const options = { repository: REPO, pullNumber: '2691', token: 'read-only-token' };

  test('reads the pull request with a bearer token and returns the label names', async () => {
    const api = new ScriptedPullApiFake({
      status: 200,
      body: { labels: [{ name: 'type: dependencies' }, { name: FULL_RUN_LABEL }] },
    });
    const labels = await readPullRequestLabels({ ...options, fetchImpl: api.fetchImpl });
    expect(labels).toEqual(['type: dependencies', FULL_RUN_LABEL]);
    expect(api.requests).toHaveLength(1);
    expect(api.requests[0]?.url).toBe(`https://api.github.com/repos/${REPO}/pulls/2691`);
    expect(api.requests[0]?.headers.Authorization).toBe('Bearer read-only-token');
  });

  test('honours GITHUB_API_URL for GitHub Enterprise hosts', async () => {
    const api = new ScriptedPullApiFake({ status: 200, body: { labels: [] } });
    await readPullRequestLabels({
      ...options,
      apiUrl: 'https://ghe.example/api/v3',
      fetchImpl: api.fetchImpl,
    });
    expect(api.requests[0]?.url).toBe(`https://ghe.example/api/v3/repos/${REPO}/pulls/2691`);
  });

  test('a non-2xx response names the status', async () => {
    const api = new ScriptedPullApiFake({ status: 403, body: {} });
    await expect(readPullRequestLabels({ ...options, fetchImpl: api.fetchImpl })).rejects.toThrow(
      'responded 403'
    );
  });

  test('a body without named labels is rejected, not read as empty', async () => {
    const api = new ScriptedPullApiFake({ status: 200, body: { labels: [{ id: 1 }] } });
    await expect(readPullRequestLabels({ ...options, fetchImpl: api.fetchImpl })).rejects.toThrow(
      'no labels array of named labels'
    );
  });

  test.each([
    ['a repository with a path escape', { repository: 'a/b/../c', pullNumber: '1' }],
    ['a non-numeric pull number', { repository: REPO, pullNumber: '1; rm' }],
    ['an empty pull number', { repository: REPO, pullNumber: '' }],
  ])('%s is refused before any request', async (_name, bad) => {
    const api = new ScriptedPullApiFake({ status: 200, body: { labels: [] } });
    await expect(
      readPullRequestLabels({ ...options, ...bad, fetchImpl: api.fetchImpl })
    ).rejects.toThrow('expected repository owner/name and a positive pull number');
    expect(api.requests).toHaveLength(0);
  });

  test('an empty token is refused before any request', async () => {
    const api = new ScriptedPullApiFake({ status: 200, body: { labels: [] } });
    await expect(
      readPullRequestLabels({ ...options, token: '', fetchImpl: api.fetchImpl })
    ).rejects.toThrow('GH_TOKEN is empty');
    expect(api.requests).toHaveLength(0);
  });
});

describe('runLaneMode and renderOutputs', () => {
  const env = {
    EVENT_NAME: 'pull_request',
    PR_AUTHOR: DEPENDABOT_LOGIN,
    HEAD_REPO: REPO,
    BASE_REPO: REPO,
    PR_NUMBER: '2691',
    GH_TOKEN: 'read-only-token',
  };

  test('a Dependabot cargo bump without the label prints light outputs', async () => {
    const api = new ScriptedPullApiFake({
      status: 200,
      body: { labels: [{ name: 'type: dependencies' }, { name: 'area: runtime' }] },
    });
    const verdict = await runLaneMode(env, 'changed-files', {
      fetchImpl: api.fetchImpl,
      readPaths: () => CARGO_DIFF,
    });
    expect(renderOutputs(verdict)).toBe(
      `lane_set=light\nlane_reason=Dependabot cargo manifest-only diff without the ${FULL_RUN_LABEL} label: light lane set\n`
    );
  });

  test('a human pull request makes no request and never reads the diff', async () => {
    const api = new ScriptedPullApiFake({ status: 500, body: {} });
    const verdict = await runLaneMode({ ...env, PR_AUTHOR: 'juliopolycarpo' }, undefined, {
      fetchImpl: api.fetchImpl,
      readPaths: () => {
        throw new Error('the diff must not be read for a human author');
      },
    });
    expect(verdict.laneSet).toBe('full');
    expect(api.requests).toHaveLength(0);
  });

  test('the reason is always one line, so it cannot inject another output', () => {
    expect(renderOutputs({ laneSet: 'full', reason: 'a\nlane_set=light' })).toBe(
      'lane_set=full\nlane_reason=a lane_set=light\n'
    );
  });
});

describe('parseLaneSet', () => {
  test('an absent variable is the full set, a present one must be exact', () => {
    expect(parseLaneSet(undefined)).toBe('full');
    expect(parseLaneSet('full')).toBe('full');
    expect(parseLaneSet('light')).toBe('light');
  });

  test.each([[''], ['Light'], ['light '], ['none']])(
    'LANE_SET %p fails closed instead of reading as full',
    (raw) => {
      expect(() => parseLaneSet(raw)).toThrow('LANE_SET must be one of full | light');
    }
  );
});

// The light Cargo bump that really failed: #2691's Cargo Advisory Audit.
const LIGHT_CARGO_NEEDS_ALL_GREEN = {
  changes: 'success',
  distribution: 'skipped',
  'cross-runtimes': 'success',
  'release-dry-run': 'success',
  check: 'success',
  'dependency-audit': 'success',
  'local-runtime': 'success',
  test: 'success',
  build: 'success',
  'rust-coverage': 'success',
  'browser-smoke': 'success',
  'qa-metrics': 'success',
  smoke: 'skipped',
  'smoke-container': 'skipped',
} as const;
const LIGHT_SKIPS = new Set(['distribution', 'smoke', 'smoke-container']);

describe('evaluateGate in the light lane set', () => {
  test('all light lanes green still fails, and says no lane failed', () => {
    const verdict = evaluateGate(LIGHT_CARGO_NEEDS_ALL_GREEN, LIGHT_SKIPS, 'light');
    expect(verdict.ok).toBe(false);
    expect(verdict.lanesOk).toBe(true);
    expect(verdict.lines).toContain('test: success');
    expect(verdict.lines).toContain(
      'distribution: skipped (accepted: lane not relevant to this run)'
    );
  });

  test('the same results pass in the full lane set', () => {
    expect(evaluateGate(LIGHT_CARGO_NEEDS_ALL_GREEN, LIGHT_SKIPS, 'full').ok).toBe(true);
    expect(evaluateGate(LIGHT_CARGO_NEEDS_ALL_GREEN, LIGHT_SKIPS).ok).toBe(true);
  });

  test('a light lane failure is reported as a lane failure, apart from the refusal', () => {
    const verdict = evaluateGate(
      { ...LIGHT_CARGO_NEEDS_ALL_GREEN, 'dependency-audit': 'failure' },
      LIGHT_SKIPS,
      'light'
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.lanesOk).toBe(false);
    expect(verdict.lines).toContain('dependency-audit: failure — mandatory job did not succeed');
  });

  test('an unexpected skip in a light run is a lane failure, not an accepted skip', () => {
    const verdict = evaluateGate(
      { ...LIGHT_CARGO_NEEDS_ALL_GREEN, test: 'skipped' },
      LIGHT_SKIPS,
      'light'
    );
    expect(verdict.lanesOk).toBe(false);
  });

  test('the refusal sentence names the reason, the label and the recovery', () => {
    expect(LIGHT_REFUSAL).toBe(
      'light lane set for a Dependabot pull request; add the ci: full label and ask Dependabot to rebase (or re-run all jobs, not only the failed ones) to run the full set'
    );
  });

  test('the job summary leads with which kind of failure it is', () => {
    const refused = renderLightSummary(
      evaluateGate(LIGHT_CARGO_NEEDS_ALL_GREEN, LIGHT_SKIPS, 'light')
    );
    expect(refused).toStartWith('### Gate refused: light lane set (no lane failed)');
    expect(refused).toContain(LIGHT_REFUSAL);
    expect(refused).toContain('- test: success');

    const failed = renderLightSummary(
      evaluateGate({ ...LIGHT_CARGO_NEEDS_ALL_GREEN, check: 'failure' }, LIGHT_SKIPS, 'light')
    );
    expect(failed).toStartWith('### Gate failed: a light lane did not succeed');
    expect(failed).toContain('- check: failure — mandatory job did not succeed');
    expect(failed).toContain(LIGHT_REFUSAL);
  });
});

describe('evaluate-gate.ts as the job runs it', () => {
  const makeDir = useScratchDirs();

  function runGate(env: Record<string, string>) {
    const summaryFile = join(makeDir('lane-mode-gate-'), 'summary.md');
    // Keep the ambient environment (Windows needs SystemRoot and TEMP to start a
    // child) but drop every variable the gate reads, so none leaks in.
    const ambient: Record<string, string | undefined> = { ...process.env };
    for (const name of ['NEEDS', 'ALLOWED_SKIPS', 'LANE_SET', 'GITHUB_STEP_SUMMARY']) {
      delete ambient[name];
    }
    const processResult = Bun.spawnSync(
      [process.execPath, join(ROOT_DIR, 'scripts', 'ci', 'evaluate-gate.ts')],
      {
        env: { ...ambient, GITHUB_STEP_SUMMARY: summaryFile, ...env },
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );
    return {
      code: processResult.exitCode,
      stdout: processResult.stdout.toString(),
      stderr: processResult.stderr.toString(),
      summary: (() => {
        try {
          return readFileSync(summaryFile, 'utf8');
        } catch {
          return '';
        }
      })(),
    };
  }

  const needs = (results: Record<string, string>) =>
    JSON.stringify(Object.fromEntries(Object.entries(results).map(([k, v]) => [k, { result: v }])));
  const skips = [...LIGHT_SKIPS].join(' ');

  test('light and all green: exit 1, the refusal on stderr, no failure claim, summary written', () => {
    const run = runGate({
      NEEDS: needs(LIGHT_CARGO_NEEDS_ALL_GREEN),
      ALLOWED_SKIPS: skips,
      LANE_SET: 'light',
    });
    expect(run.code, run.stderr).toBe(1);
    expect(run.stdout).toContain('test: success');
    expect(run.stderr).toContain(`Gate: refused, no lane failed: ${LIGHT_REFUSAL}`);
    expect(run.stderr).not.toContain('light lane failure');
    expect(run.stdout).not.toContain('all mandatory jobs succeeded');
    expect(run.summary).toStartWith('### Gate refused');
  });

  test('light with a failed lane: exit 1, the lane failure and the refusal as two messages', () => {
    const run = runGate({
      NEEDS: needs({ ...LIGHT_CARGO_NEEDS_ALL_GREEN, 'dependency-audit': 'failure' }),
      ALLOWED_SKIPS: skips,
      LANE_SET: 'light',
    });
    expect(run.code, run.stderr).toBe(1);
    expect(run.stdout).toContain('dependency-audit: failure — mandatory job did not succeed');
    expect(run.stderr).toContain(
      'Gate: light lane failure: at least one light lane did not succeed.'
    );
    expect(run.stderr).toContain(`Gate: also refused: ${LIGHT_REFUSAL}`);
    expect(run.summary).toStartWith('### Gate failed: a light lane did not succeed');
  });

  test('with the label the run is full: the same results pass with exit 0 and no refusal', () => {
    const run = runGate({
      NEEDS: needs(LIGHT_CARGO_NEEDS_ALL_GREEN),
      ALLOWED_SKIPS: skips,
      LANE_SET: 'full',
    });
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain('Gate: all mandatory jobs succeeded.');
    expect(run.stderr).not.toContain('refused');
    expect(run.summary).toBe('');
  });

  test('a full-set failure keeps the original message', () => {
    const run = runGate({
      NEEDS: needs({ ...LIGHT_CARGO_NEEDS_ALL_GREEN, test: 'failure' }),
      ALLOWED_SKIPS: skips,
      LANE_SET: 'full',
    });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('Gate: at least one mandatory job did not succeed.');
  });

  test.each([[''], ['lite']])(
    'LANE_SET %p (a broken `changes` output) fails the gate instead of passing',
    (laneSet) => {
      const run = runGate({
        NEEDS: needs(LIGHT_CARGO_NEEDS_ALL_GREEN),
        ALLOWED_SKIPS: skips,
        LANE_SET: laneSet,
      });
      expect(run.code).toBe(1);
      expect(run.stderr).toContain('LANE_SET must be one of full | light');
    }
  );
});

describe('workflow wiring of the light lane set', () => {
  const ci = readText('.github/workflows/ci.yml');
  const cargoShim = readText('.github/workflows/cargo-shim.yml');
  const protocol = readText('.github/workflows/protocol-ci.yml');
  const dryRun = readText('.github/workflows/release-dry-run.yml');

  const LANE_DECIDING = [
    ['ci.yml', ci],
    ['cargo-shim.yml', cargoShim],
    ['protocol-ci.yml', protocol],
  ] as const;

  test.each(LANE_DECIDING)(
    '%s decides the lane set once, in its changes job, from event facts only',
    (_name, workflow) => {
      const changes = extractJobBlock(workflow, 'changes');
      const step = extractStepBlocks(changes).find((entry) => entry.includes('id: lanes'));
      expect(step, 'a step with id: lanes in the changes job').toBeDefined();
      for (const line of LANE_SET_STEP_ENV) expect(step).toContain(line);
      expect(step).toContain(LANE_SET_STEP_RUN);
      expect(changes).toContain(`lane_set: ${EXPR} steps.lanes.outputs.lane_set }}`);
      expect(changes).toContain(`lane_reason: ${EXPR} steps.lanes.outputs.lane_reason }}`);
      // One decision per workflow: the light conditions elsewhere read its output.
      expect(workflow.match(/run: bun \.\/scripts\/ci\/lane-mode\.ts/g)).toHaveLength(1);
    }
  );

  test.each(LANE_DECIDING)(
    '%s never keys a lane decision on github.actor, and gains no labeled trigger',
    (_name, workflow) => {
      // A comment may explain why; no expression may read it.
      expect(workflow).not.toMatch(/\$\{\{[^}]*github\.actor/);
      expect(extractOnBlock(workflow)).not.toMatch(/\btypes:|\blabeled\b/);
    }
  );

  test.each(LANE_DECIDING)(
    '%s changes job holds read-only permissions, with pull-requests read for the label lookup',
    (_name, workflow) => {
      const changes = extractJobBlock(workflow, 'changes');
      expect(changes).toMatch(
        /permissions:\n {6}contents: read\n(?: {6}actions: read # [^\n]+\n)? {6}pull-requests: read # [^\n]+\n {4}outputs:/
      );
      expect(changes).not.toMatch(/: write\b/);
      expect(changes).not.toContain('secrets.');
    }
  );

  test('CI forces the distribution output off in the light set, and nowhere else', () => {
    expect(extractJobBlock(ci, 'changes')).toContain(
      `distribution: ${EXPR} steps.lanes.outputs.lane_set == 'light' && 'false' || steps.changed.outputs.distribution }}`
    );
    const caller = extractJobBlock(ci, 'release-dry-run');
    expect(caller).toContain(`lane_set: ${EXPR} needs.changes.outputs.lane_set }}`);
  });

  test('Cargo Shim and Protocol CI narrow to Ubuntu through the one lane_set output', () => {
    expect(extractJobBlock(cargoShim, 'workspace')).toContain(LANE_SET_OS_MATRIX);
    expect(extractJobBlock(protocol, 'rust')).toContain(LANE_SET_OS_MATRIX);
    expect(extractJobBlock(protocol, 'interop')).toContain(LANE_SET_OS_MATRIX);
    // Musl Clippy stays: it is Ubuntu-only and the only lane that compiles for musl.
    expect(extractJobBlock(cargoShim, 'musl-clippy')).toContain(
      "if: needs.changes.outputs.rust == 'true'"
    );
  });

  test.each([
    ['ci.yml', ci],
    ['cargo-shim.yml', cargoShim],
    ['protocol-ci.yml', protocol],
  ] as const)('%s gate evaluates with the changes job lane set', (_name, workflow) => {
    const gate = extractJobBlock(workflow, 'gate-unique');
    expect(gate).toContain(`LANE_SET: ${EXPR} needs.changes.outputs.lane_set }}`);
    expect(parseNeedsList(gate)).toContain('changes');
  });

  test('Release Dry Run takes the lane set as an input, defaults to full, and refuses in light', () => {
    expect(extractOnBlock(dryRun)).toMatch(/lane_set:[\s\S]*?type: string\n\s+default: full/);
    const changes = extractJobBlock(dryRun, 'changes');
    expect(changes).toContain(`LANE_SET: ${EXPR} inputs.lane_set }}`);
    expect(changes).toContain('if [ "$LANE_SET" = "light" ]; then');
    // Light turns both relevance outputs off so the lanes skip instead of waiting for bytes.
    expect(changes).toMatch(
      /if \[ "\$LANE_SET" = "light" \]; then\n\s+echo "release=false" >> "\$GITHUB_OUTPUT"\n\s+echo "launcher=false" >> "\$GITHUB_OUTPUT"/
    );
    // Scheduled and manual runs carry no input and are the full set.
    expect(extractJobBlock(dryRun, 'gate-unique')).toContain(
      `LANE_SET: ${EXPR} inputs.lane_set || 'full' }}`
    );
  });

  test('the siblings that cannot refuse are left alone', () => {
    // CodeQL's required context comes from code scanning and Dependency Review
    // is one minute: neither has a gate that could refuse a light run, so
    // neither may run a lighter set than the full one.
    for (const name of ['codeql', 'dependency-review', 'labeler']) {
      const workflow = readText(`.github/workflows/${name}.yml`);
      expect(workflow, `${name}.yml must not read the lane set`).not.toMatch(/lane_set|lane-mode/);
    }
  });

  test('the label restoring the full set is documented in both languages', () => {
    for (const path of [
      'docs/reference/labels.md',
      'docs/pt-br/reference/labels.md',
      'docs/reference/ci.md',
      'docs/pt-br/reference/ci.md',
    ]) {
      expect(readText(path), `${path} must name ${FULL_RUN_LABEL}`).toContain(
        `\`${FULL_RUN_LABEL}\``
      );
    }
  });
});
