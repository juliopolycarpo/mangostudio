import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dryRunTargetArtifacts } from '../ci/dry-run-artifacts';
import { ROOT_DIR } from '../lib/config';
import { distributionArtifactName } from '../lib/distribution-manifest';
import { readText } from './support/read-text';
import {
  extractJobBlock,
  extractStepBlocks,
  parseNeedsList,
  runScriptLines,
} from './support/workflow-blocks';

const EXPR = '$' + '{{';
const WORKFLOW = readText('.github/workflows/release-dry-run.yml');
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

describe('same-run release dry-run runtime reuse', () => {
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
