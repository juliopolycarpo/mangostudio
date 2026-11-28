import { describe, expect, test } from 'bun:test';

import { readText } from './support/read-text';
import {
  extractJobBlock,
  extractJobBlocks,
  extractOnBlock,
  extractStepBlock,
  extractStepBlocks,
  extractTopLevelBlock,
} from './support/workflow-blocks';
import { workflowFiles } from './support/workflow-files';

// Stage 4 of #2698 lets a main push skip cargo by reusing an earlier run's unstamped runtime.
// These tests pin where that can happen: one job, one context, behind one repository variable,
// and nowhere a release is built.

const EXPR = '$' + '{{';
const RUNTIME_WORKFLOW = '.github/workflows/runtime-build.yml';
const DISTRIBUTION_WORKFLOW = '.github/workflows/distribution-build.yml';
const CI_WORKFLOW = '.github/workflows/ci.yml';
const RELEASE_WORKFLOW = '.github/workflows/release.yml';

/** Every clause a reuse step must carry in its own `if`, so none can run on another path. */
const GATE_CLAUSES = [
  'inputs.reuse',
  "inputs.mode == 'artifact'",
  "inputs.profile == 'shipping'",
  "github.event_name == 'push'",
  "github.ref == 'refs/heads/main'",
  "vars.RUNTIME_REUSE == 'true'",
  "steps.digest.outcome == 'success'",
];

/** The steps that exist only to reuse a base, in workflow order. */
const REUSE_STEPS = [
  'Skip runtime base reuse on a cargo cache miss',
  'Find reusable runtime base',
  'Download reusable runtime base',
  'Verify reusable runtime base',
  'Use reused runtime base',
  'Upload runtime reuse record',
  'Warn that the runtime base was not reused',
  'Warn that the runtime reuse record was not published',
];

/** Reuse steps whose failure must leave the build to compile from source. */
const FALLBACK_STEPS = [
  'Find reusable runtime base',
  'Download reusable runtime base',
  'Verify reusable runtime base',
  'Upload runtime reuse record',
];

/** The two steps that read the outcome of reuse without being part of it. */
const CONSUMER_STEPS = ['Stage unstamped runtime', 'Build runtime'];

const runtimeJob = () => extractJobBlock(readText(RUNTIME_WORKFLOW), 'runtime');
const runtimeStep = (name: string) => extractStepBlock(runtimeJob(), name);
const ifOf = (step: string) => /^ {8}if: (.+)$/m.exec(step)?.[1] ?? '';

describe('runtime reuse gate', () => {
  test.each(REUSE_STEPS)('%s repeats the whole gate in its own condition', (name) => {
    const condition = ifOf(runtimeStep(name));
    const missing = GATE_CLAUSES.filter((clause) => !condition.includes(clause));
    expect(
      missing,
      `(runtime-build.yml step "${name}" if): expected every gate clause | received: ${condition || '<none>'}`
    ).toEqual([]);
  });

  test('the find step needs an exact cargo cache hit when the cache is on, and the skip step says so otherwise', () => {
    expect(ifOf(runtimeStep('Find reusable runtime base'))).toContain(
      "(!inputs.cache || steps.rust-cache.outputs.cache-hit == 'true')"
    );
    expect(ifOf(runtimeStep('Skip runtime base reuse on a cargo cache miss'))).toContain(
      "inputs.cache && steps.rust-cache.outputs.cache-hit != 'true'"
    );
  });

  test('the download and the verification hang off the search, the marker off the verification', () => {
    expect(ifOf(runtimeStep('Download reusable runtime base'))).toContain(
      "steps.reuse-find.outputs.reuse == 'true'"
    );
    expect(ifOf(runtimeStep('Verify reusable runtime base'))).toContain(
      "steps.reuse-download.outcome == 'success'"
    );
    expect(ifOf(runtimeStep('Use reused runtime base'))).toContain(
      "steps.reuse-verify.outcome == 'success'"
    );
    expect(ifOf(runtimeStep('Upload runtime reuse record'))).toContain(
      "steps.reuse.outcome == 'success'"
    );
  });

  test('no step outside the reuse set mentions reuse, apart from the two that consume its outcome', () => {
    const named = (step: string) => /^ {6}- name: (.+)$/m.exec(step)?.[1] ?? '<unnamed>';
    const mentioning = extractStepBlocks(runtimeJob())
      .filter((step) =>
        /runtime-base-reuse|download-run-artifact|vars\.RUNTIME_REUSE|steps\.reuse|inputs\.reuse|PREBUILT_UNSTAMPED/.test(
          step
        )
      )
      .map(named);
    expect(mentioning.sort()).toEqual([...REUSE_STEPS, ...CONSUMER_STEPS].sort());
  });

  test('the digest step stays where the cargo cache environment is already exported', () => {
    const names = extractStepBlocks(runtimeJob()).map(
      (step) => /^ {6}- name: (.+)$/m.exec(step)?.[1]
    );
    const at = (name: string) => names.indexOf(name);
    expect(at('Restore the cargo cache')).toBeLessThan(at('Compute runtime input digest'));
    for (const name of REUSE_STEPS.slice(0, 6)) {
      expect(at('Compute runtime input digest'), name).toBeLessThan(at(name));
      expect(at(name), name).toBeLessThan(at('Build runtime'));
    }
  });

  test('only the runtime build workflow and its caller chain know the variable or the CLI', () => {
    const offenders = workflowFiles()
      .filter((path) => path !== RUNTIME_WORKFLOW)
      .filter((path) =>
        /vars\.RUNTIME_REUSE|runtime-base-reuse\.ts|--prebuilt-unstamped/.test(readText(path))
      );
    expect(offenders, 'workflows outside runtime-build.yml that reach the reuse path').toEqual([]);
  });
});

describe('runtime reuse fallback', () => {
  test.each(FALLBACK_STEPS)('%s cannot fail the job', (name) => {
    expect(runtimeStep(name)).toMatch(/^ {8}continue-on-error: true$/m);
  });

  test('the marker step has no way to fail for a reason of its own', () => {
    const marker = runtimeStep('Use reused runtime base');
    // Canary reads this step's conclusion; `continue-on-error` would make a failed one read as success.
    expect(marker).not.toContain('continue-on-error');
    expect(marker).toMatch(
      /^ {8}run: cat "\$\{RUNNER_TEMP\}\/runtime-reuse-summary\.md" >> "\$GITHUB_STEP_SUMMARY"$/m
    );
  });

  test('the build still runs on every path and takes a base only after the marker succeeded', () => {
    const build = runtimeStep('Build runtime');
    expect(ifOf(build)).not.toMatch(/reuse/);
    expect(build).toContain(
      `PREBUILT_UNSTAMPED: ${EXPR} steps.reuse.outcome == 'success' && steps.reuse-verify.outputs.path || '' }}`
    );
    expect(build).toContain('--prebuilt-unstamped "$PREBUILT_UNSTAMPED"');
    expect(build).toMatch(/if \[ -n "\$PREBUILT_UNSTAMPED" \]; then/);
  });

  test('a reused base is not published again as an unstamped runtime', () => {
    expect(ifOf(runtimeStep('Stage unstamped runtime'))).toContain(
      "steps.reuse.outcome != 'success'"
    );
  });

  test('the warnings name the failed outcomes and the record the run keeps', () => {
    const notReused = runtimeStep('Warn that the runtime base was not reused');
    for (const id of ['reuse-find', 'reuse-download', 'reuse-verify']) {
      expect(notReused).toContain(`steps.${id}.outcome == 'failure'`);
    }
    expect(notReused).toContain('::warning');
    expect(ifOf(runtimeStep('Warn that the runtime reuse record was not published'))).toContain(
      "steps.reuse-record.outcome == 'failure'"
    );
  });

  test('the record is kept as long as a canary may publish from the run and is never the base', () => {
    const record = runtimeStep('Upload runtime reuse record');
    expect(record).toContain('retention-days: 30');
    expect(record).toContain('if-no-files-found: error');
    expect(record).toContain(`name: ${EXPR} steps.reuse-verify.outputs.record-name }}`);
    expect(record).toContain('path: $' + '{{ runner.temp }}/runtime-reuse-record');
    expect(record).not.toContain('runtime-base');
  });
});

describe('runtime reuse permissions and pins', () => {
  test('the workflow stays read-only, and the job asks for actions: read and nothing more', () => {
    const workflow = readText(RUNTIME_WORKFLOW);
    expect(extractTopLevelBlock(workflow, 'permissions').trim()).toBe('contents: read');
    const job = runtimeJob();
    const permissions = /^ {4}permissions:\n((?: {6}.+\n)+)/m.exec(job)?.[1] ?? '';
    expect(
      permissions
        .split('\n')
        .filter(Boolean)
        .map((line) => line.replace(/ #.*$/, '').trim())
    ).toEqual(['contents: read', 'actions: read']);
    expect(workflow).not.toMatch(/: write\b/);
  });

  test('only the search and the verification carry a token, and no step passes it to a build', () => {
    const withToken = extractStepBlocks(runtimeJob())
      .filter((step) => /github\.token|GH_TOKEN/.test(step))
      .map((step) => /^ {6}- name: (.+)$/m.exec(step)?.[1]);
    expect(withToken.sort()).toEqual(
      ['Find reusable runtime base', 'Verify reusable runtime base'].sort()
    );
  });

  test('every action is the local copy or pinned to a full commit', () => {
    const uses = [...readText(RUNTIME_WORKFLOW).matchAll(/^\s+(?:- )?uses: (\S+)/gm)].map(
      (match) => match[1] as string
    );
    expect(uses.length).toBeGreaterThan(8);
    const loose = uses.filter(
      (action) => !action.startsWith('./') && !/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/.test(action)
    );
    expect(loose, 'runtime-build.yml actions neither local nor pinned to a 40-hex SHA').toEqual([]);
  });

  test('the record upload uses the same upload-artifact pin as the other uploads', () => {
    const pin = (step: string) => /uses: (actions\/upload-artifact@\S+)/.exec(step)?.[1];
    expect(pin(runtimeStep('Upload runtime reuse record'))).toBeDefined();
    expect(pin(runtimeStep('Upload runtime reuse record'))).toBe(
      pin(runtimeStep('Upload runtime'))
    );
  });

  test('the base comes through the bounded gh download, from the producer run, under a timeout', () => {
    const download = runtimeStep('Download reusable runtime base');
    expect(download).toContain('uses: ./.github/actions/download-run-artifact');
    expect(download).toContain(`run-id: ${EXPR} steps.reuse-find.outputs.run-id }}`);
    expect(download).toContain(`name: ${EXPR} steps.reuse-find.outputs.artifact-name }}`);
    expect(download).toMatch(/^ {8}timeout-minutes: 3$/m);
    expect(download).not.toContain('actions/download-artifact');
    // The step downloads into the directory the verification reads, and nowhere the build stages.
    expect(download).toContain('path: $' + '{{ runner.temp }}/runtime-base');
    expect(runtimeStep('Verify reusable runtime base')).toContain(
      '--dir "$' + '{RUNNER_TEMP}/runtime-base"'
    );
  });

  test('the search and the verification are bounded by a step timeout', () => {
    for (const name of ['Find reusable runtime base', 'Verify reusable runtime base']) {
      expect(runtimeStep(name), name).toMatch(/^ {8}timeout-minutes: 3$/m);
    }
  });

  test('every job that reaches runtime-build.yml grants actions: read, because a called job cannot widen its caller', () => {
    const reaching: string[] = [];
    const missing: string[] = [];
    for (const path of workflowFiles()) {
      const text = readText(path);
      const workflowLevel = /actions: read/.test(extractTopLevelBlock(text, 'permissions'));
      for (const { job, block } of extractJobBlocks(text)) {
        if (
          !/uses: \$\/\.github\/workflows\/(?:runtime-build|distribution-build)\.yml/.test(block)
        ) {
          continue;
        }
        reaching.push(`${path}:${job}`);
        const jobLevel = /^ {4}permissions:\n(?: {6}.+\n)*? {6}actions: read/m.test(`${block}\n`);
        if (!workflowLevel && !jobLevel) missing.push(`${path}:${job}`);
      }
    }
    // A counted scan cannot pass by finding nothing.
    expect(reaching).toHaveLength(10);
    expect(missing, 'jobs calling a runtime build without actions: read').toEqual([]);
  });
});

describe('runtime reuse callers', () => {
  const passes = (path: string, job: string) =>
    /^ {6}reuse: (.+)$/m.exec(extractJobBlock(readText(path), job))?.[1];

  test('the reuse input is off by default in both reusable workflows', () => {
    for (const path of [RUNTIME_WORKFLOW, DISTRIBUTION_WORKFLOW]) {
      const inputs = /\n {6}reuse:\n((?: {8}.+\n)+)/.exec(readText(path))?.[1] ?? '';
      expect(inputs, path).toMatch(/^ {8}type: boolean$/m);
      expect(inputs, path).toMatch(/^ {8}default: false$/m);
    }
  });

  test('every runtime call in the distribution forwards the one input', () => {
    const calls = extractJobBlocks(readText(DISTRIBUTION_WORKFLOW)).filter(({ block }) =>
      block.includes('uses: $/.github/workflows/runtime-build.yml')
    );
    expect(calls).toHaveLength(5);
    for (const { job, block } of calls) {
      expect(block, job).toContain(`reuse: ${EXPR} inputs.reuse }}`);
    }
  });

  test('only the main push distribution of ci.yml opts in', () => {
    expect(passes(CI_WORKFLOW, 'distribution')).toBe(
      `${EXPR} github.event_name == 'push' && github.ref == 'refs/heads/main' }}`
    );
    const optedIn = workflowFiles()
      .filter((path) => path !== DISTRIBUTION_WORKFLOW)
      .flatMap((path) =>
        extractJobBlocks(readText(path))
          .filter(({ block }) => /^ {6}reuse:/m.test(block))
          .map(({ job }) => `${path}:${job}`)
      );
    expect(optedIn).toEqual([`${CI_WORKFLOW}:distribution`]);
  });

  test('stable releases always build from source', () => {
    const release = readText(RELEASE_WORKFLOW);
    // The release workflow never names the input or the variable ...
    expect(release).not.toMatch(/^\s+reuse:|RUNTIME_REUSE/m);
    // ... reaches the runtime build only through its `build` job ...
    expect(extractJobBlock(release, 'build')).toContain(
      'uses: $/.github/workflows/distribution-build.yml'
    );
    // ... and runs only for a tag push or a dispatch, never a push to a branch, which the
    // gate (`event_name == 'push' && ref == 'refs/heads/main'`) would otherwise admit.
    const on = extractOnBlock(release);
    expect(on).toMatch(/push:\n {4}tags:/);
    expect(on).not.toMatch(/branches/);
    for (const clause of ["github.event_name == 'push'", "github.ref == 'refs/heads/main'"]) {
      expect(ifOf(runtimeStep('Find reusable runtime base')), clause).toContain(clause);
    }
  });

  test('the light profile, dispatch and dry-run callers never opt in and never gain the variable', () => {
    for (const path of [
      '.github/workflows/smoke-binary.yml',
      '.github/workflows/release-dry-run.yml',
    ]) {
      expect(readText(path), path).not.toMatch(/^ {6}reuse:/m);
    }
    expect(passes(CI_WORKFLOW, 'runtime-cache-seed')).toBeUndefined();
  });
});
