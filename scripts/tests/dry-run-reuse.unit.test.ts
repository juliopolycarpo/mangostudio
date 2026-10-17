import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dryRunTargetArtifacts } from '../ci/dry-run-artifacts';
import { evaluateGate } from '../ci/evaluate-gate';
import { ROOT_DIR } from '../lib/config';
import { distributionArtifactName } from '../lib/distribution-manifest';
import { readText } from './support/read-text';
import {
  extractJobBlock,
  extractJobBlocks,
  extractStepBlocks,
  parseNeedsList,
  runScriptLines,
} from './support/workflow-blocks';

const EXPR = '$' + '{{';
const WORKFLOW = readText('.github/workflows/release-dry-run.yml');
const CI = readText('.github/workflows/ci.yml');
const stepNamed = (job: string, name: string): string => {
  const step = extractStepBlocks(extractJobBlock(WORKFLOW, job)).find((block) =>
    block
      .split('\n')
      .some((line) => line === `      - name: ${name}` || line === `        name: ${name}`)
  );
  if (!step) throw new Error(`missing dry-run assertion: ${name}`);
  return step;
};
const scriptOf = (step: string): string => {
  const script = step.split('        run: |\n')[1];
  if (!script) throw new Error('expected a dry-run shell script');
  return script
    .split('\n')
    .map((line) => line.slice(10))
    .join('\n');
};
const runScript = async (
  script: string,
  cwd: string,
  env: Readonly<Record<string, string | undefined>> = process.env
) => {
  const child = Bun.spawn(['bash', '-c', script], { cwd, env, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
};

interface JobScenario {
  readonly results: Readonly<Record<string, string | undefined>>;
  readonly release?: string;
  readonly reuseDistribution?: boolean;
  readonly cancelled?: boolean;
  readonly event?: string;
  readonly ref?: string;
}

// Actions applies success() to the entire dependency ancestry unless a job's
// condition contains a status function. Walk the actual workflow needs so a
// skipped reuse producer remains visible beyond the direct Linux dependency.
function jobAncestors(workflow: string, target: string): string[] {
  const ancestors = new Set<string>();
  const visit = (job: string): void => {
    const block = extractJobBlock(workflow, job);
    if (!block) throw new Error(`Unknown workflow prerequisite: ${job}`);
    for (const need of parseNeedsList(block)) {
      if (ancestors.has(need)) continue;
      ancestors.add(need);
      visit(need);
    }
  };
  visit(target);
  return [...ancestors];
}

function jobRuns(workflow: string, job: string, scenario: JobScenario, override?: string): boolean {
  const block = extractJobBlock(workflow, job);
  const expression = override ?? /^ {4}if: (.+)$/m.exec(block)?.[1];
  if (!expression) throw new Error(`${job} must declare its prerequisite guard`);
  const condition = expression
    .replace(/^\$\{\{\s*|\s*\}\}$/g, '')
    .replace(
      "(needs.runtime.result == 'success' || (inputs.reuse_distribution && needs.runtime.result == 'skipped'))",
      'runtimeReady'
    );
  // Parse every atom before evaluating, including unreachable atoms. Unknown
  // syntax must require extending this executable contract, not pass silently.
  const values = condition.split(' && ').map((atom) => {
    if (atom === '!cancelled()') return !scenario.cancelled;
    if (atom === "needs.changes.outputs.release == 'true'") return scenario.release === 'true';
    if (atom === 'runtimeReady') {
      if (!parseNeedsList(block).includes('runtime'))
        throw new Error('Condition reads undeclared prerequisite: runtime');
      return (
        scenario.results.runtime === 'success' ||
        (scenario.reuseDistribution === true && scenario.results.runtime === 'skipped')
      );
    }
    if (atom === "github.event_name == 'push'") return scenario.event === 'push';
    if (atom === "github.event_name == 'pull_request'") return scenario.event === 'pull_request';
    if (atom === "github.ref == 'refs/heads/main'") return scenario.ref === 'refs/heads/main';
    const result = /^needs(?:\.([\w-]+)|\['([\w-]+)'\])\.result == 'success'$/.exec(atom);
    if (result) {
      const need = result[1] ?? result[2];
      if (!parseNeedsList(block).includes(need))
        throw new Error(`Condition reads undeclared prerequisite: ${need}`);
      return scenario.results[need] === 'success';
    }
    throw new Error(`Unknown workflow condition: ${atom}`);
  });
  const implicitSuccess =
    !scenario.cancelled &&
    jobAncestors(workflow, job).every((ancestor) => scenario.results[ancestor] === 'success');
  return values.every(Boolean) && (condition.includes('cancelled()') || implicitSuccess);
}

describe('PR dry-run caller after a skipped distribution', () => {
  const docsOnly: JobScenario = {
    results: { 'distribution-identity': 'success', changes: 'success', distribution: 'skipped' },
    event: 'pull_request',
  };

  test('runs for a docs-only PR with a skipped distribution because its status check overrides implicit success', () => {
    expect(jobRuns(CI, 'release-dry-run', docsOnly)).toBe(true);
    expect(jobRuns(CI, 'release-dry-run', docsOnly, "github.event_name == 'pull_request'")).toBe(
      false
    );
  });

  test('still reports after distribution failure, and refuses cancellation and non-PR events', () => {
    expect(
      jobRuns(CI, 'release-dry-run', {
        ...docsOnly,
        results: { ...docsOnly.results, distribution: 'failure' },
      })
    ).toBe(true);
    expect(jobRuns(CI, 'release-dry-run', { ...docsOnly, cancelled: true })).toBe(false);
    for (const event of ['push', 'workflow_dispatch', 'schedule', undefined]) {
      expect(jobRuns(CI, 'release-dry-run', { ...docsOnly, event })).toBe(false);
    }
  });
});

describe('Canary prerequisites after the PR-only dry run was added', () => {
  const mainPush: JobScenario = {
    results: {
      ...Object.fromEntries(extractJobBlocks(CI).map(({ job }) => [job, 'success'])),
      'release-dry-run': 'skipped',
    },
    event: 'push',
    ref: 'refs/heads/main',
  };
  const canaryRuns = (scenario: JobScenario, override?: string): boolean =>
    jobRuns(CI, 'canary', scenario, override);

  test('runs on a green main push despite the skipped PR-only ancestor and retains every direct producer', () => {
    expect(parseNeedsList(extractJobBlock(CI, 'canary'))).toEqual([
      'gate',
      'distribution-identity',
      'distribution',
    ]);
    expect(jobAncestors(CI, 'canary')).toContain('release-dry-run');
    expect(
      canaryRuns(mainPush, "github.event_name == 'push' && github.ref == 'refs/heads/main'")
    ).toBe(false);
    expect(canaryRuns(mainPush)).toBe(true);
  });

  test('other skips accepted by a successful Gate cannot suppress the publisher', () => {
    const gate = extractJobBlock(CI, 'gate');
    for (const skipped of ['rust-coverage', 'smoke', 'smoke-container']) {
      expect(gate).toContain(`&& '${skipped}' || ''`);
      // Gate owns relevance and has already accepted the skip. Canary must
      // trust that verdict while still requiring its three direct producers.
      expect(
        canaryRuns({ ...mainPush, results: { ...mainPush.results, [skipped]: 'skipped' } })
      ).toBe(true);
    }
  });

  test.each(['gate', 'distribution-identity', 'distribution'])(
    'refuses every unsuccessful or missing direct producer (%s)',
    (producer) => {
      for (const result of ['failure', 'cancelled', 'skipped', undefined])
        expect(
          canaryRuns({ ...mainPush, results: { ...mainPush.results, [producer]: result } })
        ).toBe(false);
    }
  );

  test('refuses cancellation, non-main refs, non-push events and unknown prerequisite syntax', () => {
    expect(canaryRuns({ ...mainPush, cancelled: true })).toBe(false);
    for (const ref of ['refs/heads/feature', 'refs/tags/v0.1.1', undefined])
      expect(canaryRuns({ ...mainPush, ref })).toBe(false);
    for (const event of ['pull_request', 'workflow_dispatch', 'schedule', undefined])
      expect(canaryRuns({ ...mainPush, event })).toBe(false);
    expect(() => canaryRuns(mainPush, "!cancelled() && needs.check.result == 'success'")).toThrow(
      'Condition reads undeclared prerequisite'
    );
  });
});

describe('light runtime cache seed after the PR-only dry run was added', () => {
  const mainPush: JobScenario = {
    results: {
      ...Object.fromEntries(extractJobBlocks(CI).map(({ job }) => [job, 'success'])),
      'release-dry-run': 'skipped',
    },
    event: 'push',
    ref: 'refs/heads/main',
  };

  test('seeds on a green main push despite the skipped PR-only ancestor', () => {
    expect(jobAncestors(CI, 'runtime-cache-seed')).toContain('release-dry-run');
    expect(jobRuns(CI, 'runtime-cache-seed', mainPush)).toBe(true);
  });

  test.each(['gate', 'distribution-identity'])(
    'refuses an unsuccessful or missing prerequisite (%s)',
    (producer) => {
      for (const result of ['failure', 'cancelled', 'skipped', undefined]) {
        expect(
          jobRuns(CI, 'runtime-cache-seed', {
            ...mainPush,
            results: { ...mainPush.results, [producer]: result },
          })
        ).toBe(false);
      }
    }
  );

  test('refuses cancellation, non-main refs and non-push events', () => {
    expect(jobRuns(CI, 'runtime-cache-seed', { ...mainPush, cancelled: true })).toBe(false);
    expect(jobRuns(CI, 'runtime-cache-seed', { ...mainPush, ref: 'refs/heads/feature' })).toBe(
      false
    );
    for (const event of ['pull_request', 'workflow_dispatch', 'schedule', undefined]) {
      expect(jobRuns(CI, 'runtime-cache-seed', { ...mainPush, event })).toBe(false);
    }
  });
});

describe('same-run release dry-run runtime reuse', () => {
  const windowsRuns = (scenario: JobScenario, override?: string): boolean =>
    jobRuns(WORKFLOW, 'dry-run-windows', scenario, override);
  const reusedRuntime: JobScenario = {
    results: { changes: 'success', runtime: 'skipped', 'dry-run-linux': 'success' },
    release: 'true',
  };

  test('Linux requires successful source and artifact validation before downloading reused runtimes', () => {
    const reused: JobScenario = { ...reusedRuntime, reuseDistribution: true };
    expect(jobRuns(WORKFLOW, 'dry-run-linux', reused)).toBe(true);
    for (const result of ['failure', 'cancelled', 'skipped', undefined]) {
      expect(
        jobRuns(WORKFLOW, 'dry-run-linux', {
          ...reused,
          results: { ...reused.results, changes: result },
        }),
        `changes=${result}: expected Linux to refuse unvalidated artifact names`
      ).toBe(false);
    }
    expect(jobRuns(WORKFLOW, 'dry-run-linux', { ...reused, cancelled: true })).toBe(false);
    expect(jobRuns(WORKFLOW, 'dry-run-linux', { ...reused, release: 'false' })).toBe(false);
    expect(
      jobRuns(WORKFLOW, 'dry-run-linux', {
        ...reused,
        reuseDistribution: false,
        results: { ...reused.results, runtime: 'success' },
      })
    ).toBe(true);
    for (const result of ['failure', 'cancelled', undefined]) {
      expect(
        jobRuns(WORKFLOW, 'dry-run-linux', {
          ...reused,
          results: { ...reused.results, runtime: result },
        })
      ).toBe(false);
    }
    expect(jobRuns(WORKFLOW, 'dry-run-linux', { ...reused, reuseDistribution: false })).toBe(false);
  });

  test('Windows runs after a successful Linux archive despite the deliberately skipped runtime ancestor', () => {
    expect(parseNeedsList(extractJobBlock(WORKFLOW, 'dry-run-windows'))).toEqual([
      'changes',
      'dry-run-linux',
    ]);
    expect(jobAncestors(WORKFLOW, 'dry-run-windows').sort()).toEqual([
      'changes',
      'dry-run-linux',
      'runtime',
    ]);
    // The previous guard's implicit success() reproduces the hosted skip even
    // though both direct prerequisites succeeded. The source guard must run.
    expect(windowsRuns(reusedRuntime, "needs.changes.outputs.release == 'true'")).toBe(false);
    expect(windowsRuns(reusedRuntime)).toBe(true);
    expect(
      windowsRuns({ ...reusedRuntime, results: { ...reusedRuntime.results, runtime: 'success' } })
    ).toBe(true);
  });

  test.each(['failure', 'skipped', 'cancelled', undefined])(
    'Windows refuses an unsuccessful or missing Linux archive (%s)',
    (result) => {
      expect(
        windowsRuns({
          ...reusedRuntime,
          results: { ...reusedRuntime.results, 'dry-run-linux': result },
        })
      ).toBe(false);
    }
  );

  test('Windows refuses cancelled, irrelevant or missing-release scenarios and unknown guard syntax', () => {
    expect(windowsRuns({ ...reusedRuntime, cancelled: true })).toBe(false);
    for (const release of ['false', '', undefined])
      expect(windowsRuns({ ...reusedRuntime, release })).toBe(false);
    expect(() =>
      windowsRuns(reusedRuntime, "always() && needs.changes.outputs.release == 'true'")
    ).toThrow('Unknown workflow condition');
  });

  test('a missing Windows execution still fails the mandatory gate on a relevant reused PR', () => {
    const gate = extractJobBlock(WORKFLOW, 'gate');
    expect(parseNeedsList(gate)).toContain('dry-run-windows');
    expect(gate).toContain("needs.changes.outputs.release == 'false' && 'dry-run-windows' || ''");
    expect(
      evaluateGate(
        {
          changes: 'success',
          runtime: 'skipped',
          'dry-run-linux': 'success',
          'dry-run-windows': 'skipped',
          'dry-run-cargo': 'success',
        },
        new Set(['runtime'])
      ).ok
    ).toBe(false);
  });

  test('rejects missing, malformed or wrong-identity artifacts before an empty download can fan out', () => {
    const source = 'a'.repeat(40);
    const version = '0.1.1-pr.7.gabcdef0';
    const valid = {
      'linux-x64': distributionArtifactName('linux-x64', source, version, 'b'.repeat(64)),
      'windows-x64': distributionArtifactName('windows-x64', source, version, 'c'.repeat(64)),
    };
    expect(dryRunTargetArtifacts(JSON.stringify(valid), source, version)).toEqual(valid);
    for (const raw of [
      '',
      'null',
      '[]',
      '{}',
      JSON.stringify({ ...valid, 'windows-x64': '' }),
      JSON.stringify({ ...valid, 'linux-x64': valid['windows-x64'] }),
    ]) {
      expect(() => dryRunTargetArtifacts(raw, source, version)).toThrow();
    }
    expect(() => dryRunTargetArtifacts(JSON.stringify(valid), 'd'.repeat(40), version)).toThrow();
    expect(() => dryRunTargetArtifacts(JSON.stringify(valid), source, '0.0.0-dryrun')).toThrow();
    const step = stepNamed('changes', 'Validate PR distribution target identities');
    expect(step).toContain(
      "if: inputs.reuse_distribution && steps.changed.outputs.release == 'true'"
    );
    expect(step).toContain('bun ./scripts/ci/dry-run-artifacts.ts >> "$GITHUB_OUTPUT"');
  });

  test('preserves every pre-reuse validation command and its runner in original order', () => {
    // Captured from acf8930f before the workflow interface changed. This pins
    // the complete assertion inventory, including multiline installer and
    // Docker scripts, instead of only a few representative commands.
    const inventory = JSON.parse(
      readText('scripts/tests/support/dry-run-command-inventory.json')
    ) as Record<
      string,
      {
        runner: string;
        commands: Array<{ name: string; run: string }>;
      }
    >;
    for (const [job, baseline] of Object.entries(inventory)) {
      const block = extractJobBlock(WORKFLOW, job);
      expect(block).toContain(`runs-on: ${baseline.runner}`);
      const commands = extractStepBlocks(block)
        .map((step) => {
          const lines = runScriptLines(step);
          const inline = /^\s*(?:- )?run: (?!\|)(.+)$/m.exec(step)?.[1];
          const run =
            inline ??
            lines
              .map((line) => line.text.slice(10))
              .join('\n')
              .trimEnd();
          const name = /^ {6}- name: (.+)$/m.exec(step)?.[1] ?? run;
          return { name, run };
        })
        .filter((command) => baseline.commands.some((expected) => expected.name === command.name));
      expect(commands, `${job} original assertion inventory`).toEqual(
        baseline.commands.map((command) => ({
          ...command,
          // The shared workflow walker omits blank lines, which do not change
          // the command/argument or shell assertion inventory.
          run: command.run
            .split('\n')
            .filter((line) => line.trim() !== '')
            .join('\n'),
        }))
      );
    }
    expect(extractJobBlock(WORKFLOW, 'dry-run-windows')).toContain('shell: powershell');
  });

  test('CI supplies exact same-run identity and artifacts, and never waits on a gate', () => {
    const ci = readText('.github/workflows/ci.yml');
    const caller = extractJobBlock(ci, 'release-dry-run');
    expect(parseNeedsList(caller)).toEqual(['distribution-identity', 'distribution']);
    expect(caller).toContain('reuse_distribution: true');
    expect(caller).toContain(`version: ${EXPR} needs.distribution-identity.outputs.version }}`);
    expect(caller).toContain(
      `source_sha: ${EXPR} needs.distribution-identity.outputs.source_sha }}`
    );
    expect(caller).toContain(`channel: ${EXPR} needs.distribution-identity.outputs.channel }}`);
    expect(caller).toContain(
      `target_artifacts: ${EXPR} needs.distribution.outputs.target_artifacts || '{}' }}`
    );
    expect(parseNeedsList(extractJobBlock(ci, 'gate'))).toContain('release-dry-run');
    expect(extractJobBlock(WORKFLOW, 'runtime')).toContain('!inputs.reuse_distribution');
    expect(extractJobBlock(WORKFLOW, 'runtime')).toContain('cache: false');
  });

  test('rejects an incorrect source, PR rebuild or non-PR reuse through the real mode guard', async () => {
    const source = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: ROOT_DIR })
      .stdout.toString()
      .trim();
    const script = scriptOf(stepNamed('changes', 'Verify dry-run source and execution mode'));
    const mode = async (overrides: Readonly<Record<string, string | undefined>>) =>
      runScript(script, ROOT_DIR, {
        ...process.env,
        EXPECTED_SHA: source,
        EVENT_NAME: 'pull_request',
        REUSE_DISTRIBUTION: 'true',
        DISTRIBUTION_VERSION: '0.1.1-pr.7.gabcdef0',
        DISTRIBUTION_CHANNEL: 'pr',
        ...overrides,
      });
    expect((await mode({})).exitCode).toBe(0);
    for (const overrides of [
      { EXPECTED_SHA: '0'.repeat(40) },
      { REUSE_DISTRIBUTION: 'false' },
      { DISTRIBUTION_VERSION: '' },
      { DISTRIBUTION_CHANNEL: 'canary' },
      { EVENT_NAME: 'schedule' },
      { EVENT_NAME: 'workflow_dispatch', REUSE_DISTRIBUTION: 'false' },
    ])
      expect((await mode(overrides)).exitCode, JSON.stringify(overrides)).not.toBe(0);
    for (const event of ['schedule', 'workflow_dispatch']) {
      expect(
        (
          await mode({
            EVENT_NAME: event,
            REUSE_DISTRIBUTION: 'false',
            DISTRIBUTION_VERSION: '',
            DISTRIBUTION_CHANNEL: '',
          })
        ).exitCode
      ).toBe(0);
    }
  });

  test('verifies both target bundles before staging their runtime bytes for the existing build commands', async () => {
    const linux = extractJobBlock(WORKFLOW, 'dry-run-linux');
    for (const [name, target] of [
      ['Download immutable Linux distribution', 'linux-x64'],
      ['Download immutable Windows distribution', 'windows-x64'],
    ]) {
      const step = stepNamed('dry-run-linux', name);
      expect(step).toContain('uses: ./.github/actions/download-distribution');
      expect(step).toContain(
        `artifact-name: ${EXPR} needs.changes.outputs.${target === 'linux-x64' ? 'linux_artifact' : 'windows_artifact'} }}`
      );
      for (const [key, input] of [
        ['source-sha', 'source_sha'],
        ['version', 'version'],
        ['channel', 'channel'],
      ]) {
        expect(step).toContain(`${key}: ${EXPR} inputs.${input} }}`);
      }
      expect(step).toContain(`target: ${target}`);
    }
    expect(linux.indexOf('Download immutable Linux distribution')).toBeLessThan(
      linux.indexOf('Clear distribution download staging')
    );
    expect(linux.indexOf('Clear distribution download staging')).toBeLessThan(
      linux.indexOf('Download immutable Windows distribution')
    );
    expect(linux.indexOf('Download immutable Windows distribution')).toBeLessThan(
      linux.indexOf('Stage verified distribution runtimes')
    );
    expect(linux.indexOf('Stage verified distribution runtimes')).toBeLessThan(
      linux.indexOf('Build Linux x64 binary')
    );
    const cwd = await mkdtemp(join(tmpdir(), 'dry-run-runtime-stage-'));
    try {
      const fixtures = [
        ['linux-x64', 'mangostudio-runtime', 'literal Linux runtime bytes'],
        ['windows-x64', 'mangostudio-runtime.exe', 'literal Windows runtime bytes'],
      ];
      for (const [platform, name, content] of fixtures)
        await Bun.write(join(cwd, '.mango/out', platform, name), content);
      const script = scriptOf(stepNamed('dry-run-linux', 'Stage verified distribution runtimes'));
      expect((await runScript(script, cwd)).exitCode).toBe(0);
      for (const [platform, name, content] of fixtures)
        expect(await Bun.file(join(cwd, '.mango/runtime-prebuilt', platform, name)).text()).toBe(
          content
        );
      await rm(join(cwd, '.mango/out/windows-x64/mangostudio-runtime.exe'));
      expect((await runScript(script, cwd)).exitCode).not.toBe(0);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
