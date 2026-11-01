import { describe, expect, test } from 'bun:test';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ROOT_DIR } from '../lib/config';
import { readText } from './support/read-text';
import { extractJobBlock, extractStepBlocks, parseNeedsList } from './support/workflow-blocks';

// Neither release path is reachable from a branch build, and a scratch tag is
// not an option: immutable releases are enabled on this repository, so a
// throwaway `v0.0.0-rc.1` would publish a real release and reserve that tag
// name permanently. So the pre-release condition is proved the only way that
// leaves no trace — by running the workflow's own script against fake `gh` and
// `docker` binaries and reading the argv they were handed.

const RELEASE_WORKFLOW = '.github/workflows/release.yml';

const releaseWorkflow = readText(RELEASE_WORKFLOW);

/**
 * The shell script of one named step, dedented to column zero so it can be fed
 * to bash. Read out of the workflow rather than duplicated here: a copy would
 * keep passing after the workflow changed underneath it — which is also why the
 * dedent is measured from the script's own first line instead of assuming the
 * column job steps happen to sit at today.
 * // Usage: stepScript('docker', 'Build and publish images (…)')
 */
function stepScript(job: string, stepName: string): string {
  const block = extractStepBlocks(extractJobBlock(releaseWorkflow, job)).find((step) =>
    step.includes(`name: ${stepName}`)
  );
  expect(block, `${RELEASE_WORKFLOW} → ${job} has no step named "${stepName}"`).toBeDefined();
  const body = /\n\s+run: \|\n([\s\S]*)$/.exec(block as string)?.[1];
  expect(body, `step "${stepName}" has no \`run: |\` script`).toBeDefined();
  const lines = (body as string).split('\n');
  const indent = lines.find((line) => line.trim() !== '')?.search(/\S/) ?? 0;
  return lines.map((line) => line.slice(indent)).join('\n');
}

/**
 * A fake executable that appends its argv to `$ARGV_LOG`, one invocation per
 * line with `|` between arguments. Space-joining would erase argument
 * boundaries — `--title "a b"` and `--title a b` log identically — and an empty
 * argument, which is exactly what a mis-quoted empty array produces, would not
 * show up at all.
 */
function argvRecorder(extra = ''): string {
  return `#!/usr/bin/env bash
(IFS='|'; printf '%s\\n' "$*" >> "$ARGV_LOG")
${extra}
exit 0
`;
}

interface StepRun {
  readonly exitCode: number;
  readonly output: string;
  /** One line per fake-binary invocation, arguments separated by \`|\`. */
  readonly argv: string[];
}

function runStepScript(
  script: string,
  options: { env: Record<string, string>; bin: Record<string, string> }
): StepRun {
  const dir = mkdtempSync(join(tmpdir(), 'release-prerelease-'));
  const binDir = join(dir, 'bin');
  mkdirSync(binDir, { recursive: true });
  for (const [name, source] of Object.entries(options.bin)) {
    writeFileSync(join(binDir, name), source, { mode: 0o755 });
  }

  // The real helpers, not stand-ins: the `--prerelease` flag has to survive
  // publish_release's own argument splitting to reach `gh release create`.
  mkdirSync(join(dir, 'scripts', 'release'), { recursive: true });
  for (const helper of ['publish-release.sh', 'retry.sh']) {
    copyFileSync(join(ROOT_DIR, 'scripts/release', helper), join(dir, 'scripts/release', helper));
  }
  mkdirSync(join(dir, 'release-assets'), { recursive: true });
  writeFileSync(join(dir, 'release-assets', 'SHA256SUMS'), 'checksums\n');
  writeFileSync(join(dir, 'RELEASE_NOTES.md'), 'notes\n');

  const argvLog = join(dir, 'argv.log');
  try {
    const proc = Bun.spawnSync({
      // The shell GitHub actually gives a `run:` with no `shell:` key on Linux:
      // `bash -e {0}`. Not `-o pipefail`, which is only added when the step asks
      // for `shell: bash` — asserting a stricter contract than production would
      // let a script that CI still breaks on pass here.
      cmd: ['bash', '--noprofile', '--norc', '-e', '-c', script],
      cwd: dir,
      env: {
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        ARGV_LOG: argvLog,
        ...options.env,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    return {
      exitCode: proc.exitCode,
      output: proc.stdout.toString() + proc.stderr.toString(),
      argv: existsSync(argvLog) ? readFileSync(argvLog, 'utf8').split('\n').filter(Boolean) : [],
    };
  } finally {
    // `mkdtempSync` has no owner but this call: without the removal every run of
    // this file leaves a temp tree behind, one per publish/build invocation.
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('the resolve step classifies the version it is releasing', () => {
  const runResolveStep = (
    env: Record<string, string>
  ): { exitCode: number; stderr: string; outputLines: string[] } => {
    const dir = mkdtempSync(join(tmpdir(), 'release-resolve-'));
    const output = join(dir, 'github-output');
    writeFileSync(output, '');
    try {
      const proc = Bun.spawnSync({
        cmd: [
          'bash',
          '--noprofile',
          '--norc',
          '-e',
          '-c',
          stepScript('prepare', 'Resolve version'),
        ],
        cwd: dir,
        env: { PATH: process.env.PATH ?? '', GITHUB_OUTPUT: output, INPUT_VERSION: '', ...env },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      return {
        exitCode: proc.exitCode,
        stderr: proc.stderr.toString(),
        outputLines: readFileSync(output, 'utf8').split('\n').filter(Boolean),
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  const resolve = (env: Record<string, string>): { version: string; prerelease: string } => {
    const { exitCode, stderr, outputLines } = runResolveStep(env);
    expect(exitCode, stderr).toBe(0);
    const written = Object.fromEntries(
      outputLines.map((line) => line.split('=') as [string, string])
    );
    return { version: written.version, prerelease: written.prerelease };
  };

  test.each([
    ['v0.2.0', '0.2.0', 'false'],
    ['v0.2.0-rc.1', '0.2.0-rc.1', 'true'],
    ['v1.0.0-beta.3', '1.0.0-beta.3', 'true'],
  ])('a %s tag push resolves prerelease=%s', (ref, version, prerelease) => {
    expect(resolve({ GITHUB_REF_NAME: ref })).toEqual({ version, prerelease });
  });

  test.each([
    ['0.2.0', 'false'],
    ['0.2.0-rc.1', 'true'],
  ])('a workflow_dispatch of %s resolves prerelease=%s', (version, prerelease) => {
    // The dispatch input wins over the ref, so the classification has to be
    // made from the resolved version rather than from the tag name.
    expect(resolve({ GITHUB_REF_NAME: 'v9.9.9', INPUT_VERSION: version })).toEqual({
      version,
      prerelease,
    });
  });

  test('a dispatch input keeps its leading v out of the resolved version', () => {
    // The input is documented as "without the leading v", and nothing downstream
    // catches one: `check:versions --expect` normalizes before comparing, so
    // `v0.2.0` clears every gate and first surfaces as the tag `vv0.2.0` — a name
    // immutable releases reserve permanently. The tag-push branch already strips
    // it; this branch has to agree.
    expect(resolve({ GITHUB_REF_NAME: 'v9.9.9', INPUT_VERSION: 'v0.2.0' })).toEqual({
      version: '0.2.0',
      prerelease: 'false',
    });
  });

  test.each([' v0.2.0', '0.2.0 ', '\t0.2.0'])(
    'a dispatch input of %j keeps whitespace out of the resolved version',
    (input) => {
      // normalizeVersion trims before it strips the `v`, so a pasted " v0.2.0"
      // clears `check:versions --expect` — and then names the tag "v v0.2.0",
      // which git refuses, after the whole distribution has already been built.
      // The two normalizations have to agree, in that order.
      expect(resolve({ GITHUB_REF_NAME: 'v9.9.9', INPUT_VERSION: input })).toEqual({
        version: '0.2.0',
        prerelease: 'false',
      });
    }
  );

  test('a dispatch input with an embedded newline cannot inject a second output key', () => {
    // `.trim()` only strips the ends; the workflow strips every `[[:space:]]`
    // character instead, so an embedded newline has nowhere to hide. A
    // trim-only rewrite would let it through unmasked, and `echo
    // "version=${version}"` would then split it into a second `$GITHUB_OUTPUT`
    // line — handing whatever follows the newline a free output key.
    const { exitCode, stderr, outputLines } = runResolveStep({
      GITHUB_REF_NAME: 'v9.9.9',
      INPUT_VERSION: '0.2.0\nmalicious=true',
    });
    expect(exitCode, stderr).toBe(0);
    expect(outputLines.filter((line) => line.startsWith('version='))).toEqual([
      'version=0.2.0malicious=true',
    ]);
  });
});

// Exercise the workflow's classification gate before its real publishing scripts.
function classificationScript(): string {
  return stepScript('validate-classification', 'Validate prerelease classification');
}

describe('release classification fails before any channel can publish', () => {
  test.each(['github-release', 'docker', 'npm-publish', 'homebrew', 'scoop'])(
    '%s cannot bypass validation through the build dependency',
    (channel) => {
      const block = extractJobBlock(releaseWorkflow, channel);
      expect(parseNeedsList(block)).toContain('build');
      expect(block).not.toMatch(/(?:always|failure)\(\)/);
      expect(parseNeedsList(extractJobBlock(releaseWorkflow, 'build'))).toContain(
        'validate-classification'
      );
      const gate = extractJobBlock(releaseWorkflow, 'validate-classification');
      expect(gate).toContain('needs: prepare');
      expect(gate).toContain('if: $' + '{{ always() }}');
      expect(extractJobBlock(releaseWorkflow, 'build')).not.toMatch(/(?:always|failure)\(\)/);
      expect(gate).toContain('PRERELEASE: $' + '{{ needs.prepare.outputs.prerelease }}');
      expect(gate).not.toContain('continue-on-error:');
    }
  );

  test.each(['', 'TRUE', 'False', 'yes', '0', ' true', 'false\n'])(
    'rejects %j before GitHub Release or Docker publication',
    (prerelease) => {
      for (const [job, step, bin] of [
        [
          'github-release',
          'Create the GitHub Release',
          {
            gh: argvRecorder('[ "$1" = "release" ] && [ "$2" = "view" ] && exit 1'),
          },
        ],
        [
          'docker',
          'Build and publish images (retrying transient registry failures)',
          {
            docker: argvRecorder(),
          },
        ],
      ] as const) {
        const result = runStepScript(`${classificationScript()}\n${stepScript(job, step)}`, {
          env: {
            PRERELEASE: prerelease,
            VERSION: '0.2.0-rc.1',
            IMAGE: 'ghcr.io/example/mangostudio',
            GH_TOKEN: 'fake',
          },
          bin,
        });
        expect(result.exitCode, `${job} published as stable: ${result.argv.join('\n')}`).not.toBe(
          0
        );
        expect(result.output).toContain('Invalid prerelease classification');
        expect(result.argv).toEqual([]);
      }
    }
  );

  test.each(['true', 'false'])('accepts exactly %s', (prerelease) => {
    const result = runStepScript(classificationScript(), {
      env: { PRERELEASE: prerelease },
      bin: {},
    });
    expect(result.exitCode, result.output).toBe(0);
  });
});

type SimulatedResult = 'success' | 'failure' | 'skipped';
interface ChannelJob {
  needs?: string | string[];
  if?: string;
  steps?: Array<{ env?: Record<string, string>; with?: Record<string, string> }>;
}

// A deliberately bounded Actions simulation: dependencies and the three actual
// channel expressions come from YAML. Builds/publish actions are receipts only;
// the classification gate runs its real shell script with no network commands.
function simulateReleaseChannels(
  prepare: SimulatedResult,
  prerelease?: string
): { validation: SimulatedResult; publications: string[] } {
  const workflow = Bun.YAML.parse(releaseWorkflow) as { jobs: Record<string, ChannelJob> };
  const results = new Map<string, SimulatedResult>([['prepare', prepare]]);
  const publications: string[] = [];
  const output = prerelease ?? '';
  const compare = (expression: string): boolean => {
    const match = /^needs\.prepare\.outputs\.prerelease (==|!=) '([^']*)'$/.exec(expression);
    if (!match) throw new Error(`Unsupported channel condition: ${expression}`);
    // GitHub string equality ignores case. The real shell validation must
    // reject TRUE/False before this comparison can select a publishing job.
    const equal = output.toLowerCase() === match[2].toLowerCase();
    return match[1] === '==' ? equal : !equal;
  };
  const run = (id: string): SimulatedResult => {
    const previous = results.get(id);
    if (previous) return previous;
    const job = workflow.jobs[id];
    if (!job) throw new Error(`Missing release job: ${id}`);
    const needs = typeof job.needs === 'string' ? [job.needs] : (job.needs ?? []);
    const dependenciesSucceeded = needs.map(run).every((result) => result === 'success');
    const always = job.if === '$' + '{{ always() }}';
    let result: SimulatedResult = 'skipped';
    if (always || (dependenciesSucceeded && (!job.if || compare(job.if)))) {
      result = 'success';
      if (id === 'validate-classification') {
        const binding = job.steps?.find((step) => step.env?.PRERELEASE)?.env?.PRERELEASE;
        if (binding !== '$' + '{{ needs.prepare.outputs.prerelease }}') {
          throw new Error(`Unsupported classification binding: ${binding}`);
        }
        // Skipped/failed prepare exposes no job output, even if an old value
        // was supplied by the fixture. A missing output omits the env key.
        const value = prepare === 'success' ? prerelease : undefined;
        const gate = runStepScript(classificationScript(), {
          env: value === undefined ? {} : { PRERELEASE: value },
          bin: {},
        });
        result = gate.exitCode === 0 ? 'success' : 'failure';
      } else if (id === 'npm-publish') {
        const expression = job.steps?.find((step) => step.with?.['dist-tag'])?.with?.['dist-tag'];
        const choice = /^\$\{\{ (.*?) && '([^']*)' \|\| '([^']*)' \}\}$/.exec(expression ?? '');
        if (!choice) throw new Error(`Unsupported npm dist-tag expression: ${expression}`);
        publications.push(`npm:${(compare(choice[1]) ? choice[2] : choice[3]) || 'latest'}`);
      } else if (['github-release', 'docker', 'homebrew', 'scoop'].includes(id)) {
        publications.push(id);
      }
    }
    results.set(id, result);
    return result;
  };
  for (const channel of ['github-release', 'docker', 'npm-publish', 'homebrew', 'scoop']) {
    run(channel);
  }
  return { validation: results.get('validate-classification') ?? 'skipped', publications };
}

describe('all publishing channel decisions share the validated output boundary', () => {
  test.each([
    {
      name: 'stable',
      value: 'false',
      expected: ['github-release', 'docker', 'npm:latest', 'homebrew', 'scoop'],
    },
    { name: 'prerelease', value: 'true', expected: ['github-release', 'docker', 'npm:next'] },
  ])('$name selects the expected channels and npm dist-tag', ({ value, expected }) => {
    expect(simulateReleaseChannels('success', value)).toEqual({
      validation: 'success',
      publications: [...expected],
    });
  });

  test.each([
    { name: 'missing output', value: undefined },
    { name: 'empty output', value: '' },
    { name: 'uppercase true', value: 'TRUE' },
    { name: 'mixed-case false', value: 'False' },
    { name: 'unexpected spelling', value: 'yes' },
    { name: 'numeric false', value: '0' },
    { name: 'leading space', value: ' true' },
    { name: 'trailing newline', value: 'false\n' },
  ])('$name fails validation and selects no publishing channel', ({ value }) => {
    expect(simulateReleaseChannels('success', value)).toEqual({
      validation: 'failure',
      publications: [],
    });
  });

  test.each(['skipped', 'failure'] as const)(
    '%s prepare still runs validation and blocks every channel',
    (prepare) => {
      expect(simulateReleaseChannels(prepare, 'false')).toEqual({
        validation: 'failure',
        publications: [],
      });
    }
  );
});

describe('the GitHub Release step marks a pre-release as one', () => {
  const publish = (prerelease: string): StepRun =>
    runStepScript(stepScript('github-release', 'Create the GitHub Release'), {
      env: { PRERELEASE: prerelease, VERSION: '0.2.0-rc.1', GH_TOKEN: 'fake' },
      // `gh release view` must report the release as missing, which is the
      // state a first publish starts from; publish_release treats a non-zero
      // exit as "missing" and goes on to create.
      bin: { gh: argvRecorder('[ "$1" = "release" ] && [ "$2" = "view" ] && exit 1') },
    });

  // Membership in the argument list, not a substring of the joined log: a
  // `|--prerelease|` match also asserts that something follows it, so reordering
  // the flags array fails the test for a reason it does not name.
  const createArgv = (result: StepRun): string[] => {
    const create = result.argv.find((call) => call.startsWith('release|create'));
    // Named here rather than in each caller: without it a missing create call
    // reports as "[''] does not contain --prerelease", which blames the flag
    // for a publish that never happened.
    expect(create, `no \`gh release create\` call was recorded:\n${result.output}`).toBeDefined();
    return (create as string).split('|');
  };
  const hasFlag = (argv: readonly string[], flag: string): boolean =>
    argv.some((part) => part === flag || part.startsWith(`${flag}=`));

  test('passes --prerelease and --latest=false for a pre-release version', () => {
    const result = publish('true');
    expect(result.exitCode, result.output).toBe(0);
    const argv = createArgv(result);
    expect(argv).toContain('--prerelease');
    // `--prerelease` labels the release; the Latest marker is a separate field,
    // and it is the one `/releases/latest` — and therefore install.sh —
    // resolves.
    expect(argv).toContain('--latest=false');
  });

  test('passes neither for a stable version, and no empty argument in their place', () => {
    const result = publish('false');
    expect(result.exitCode, result.output).toBe(0);
    const argv = createArgv(result);
    expect(hasFlag(argv, '--prerelease')).toBe(false);
    expect(hasFlag(argv, '--latest')).toBe(false);
    // An unquoted or mis-quoted empty flags array would hand `gh` an empty
    // argument, which it reads as a positional asset path and rejects. The
    // argv log keeps boundaries visible precisely so this is observable.
    expect(argv).not.toContain('');
  });

  test('carries the release notes and the tag either way', () => {
    for (const prerelease of ['true', 'false']) {
      const create = publish(prerelease).argv.find((call) => call.startsWith('release|create'));
      expect(create, prerelease).toContain('release|create|v0.2.0-rc.1|');
      expect(create, prerelease).toContain('|--notes-file|RELEASE_NOTES.md');
      expect(create, prerelease).toContain('|--title|v0.2.0-rc.1');
    }
  });
});

describe('the Docker step keeps the floating tags on the last stable', () => {
  const build = (prerelease: string): StepRun =>
    runStepScript(
      stepScript('docker', 'Build and publish images (retrying transient registry failures)'),
      {
        env: {
          PRERELEASE: prerelease,
          VERSION: '0.2.0-rc.1',
          IMAGE: 'ghcr.io/juliopolycarpo/mangostudio',
        },
        bin: { docker: argvRecorder() },
      }
    );

  // No `part !== ''` filter: an empty argument is what a mis-quoted tag array
  // produces, and dropping it here would hide the one failure the argv log keeps
  // boundaries visible for — the same failure the GitHub Release case asserts on.
  const tags = (result: StepRun): string[] =>
    result.argv.flatMap((call) => {
      const parts = call.split('|');
      return parts.filter((_part, index) => parts[index - 1] === '--tag');
    });

  test('a pre-release publishes only version-pinned tags', () => {
    const result = build('true');
    expect(result.exitCode, result.output).toBe(0);
    expect(tags(result).sort()).toEqual([
      'ghcr.io/juliopolycarpo/mangostudio:0.2.0-rc.1',
      'ghcr.io/juliopolycarpo/mangostudio:0.2.0-rc.1-alpine',
      'ghcr.io/juliopolycarpo/mangostudio:0.2.0-rc.1-bookworm',
    ]);
  });

  test('a stable release also moves latest, bookworm and alpine', () => {
    const result = build('false');
    expect(result.exitCode, result.output).toBe(0);
    expect(tags(result).sort()).toEqual([
      'ghcr.io/juliopolycarpo/mangostudio:0.2.0-rc.1',
      'ghcr.io/juliopolycarpo/mangostudio:0.2.0-rc.1-alpine',
      'ghcr.io/juliopolycarpo/mangostudio:0.2.0-rc.1-bookworm',
      'ghcr.io/juliopolycarpo/mangostudio:alpine',
      'ghcr.io/juliopolycarpo/mangostudio:bookworm',
      'ghcr.io/juliopolycarpo/mangostudio:latest',
    ]);
  });

  test('both image variants are still built in either mode', () => {
    for (const prerelease of ['true', 'false']) {
      const result = build(prerelease);
      expect(
        result.argv.filter((call) => call.startsWith('buildx|build')),
        prerelease
      ).toHaveLength(2);
      expect(
        result.argv.some((call) => call.includes('|--file|Dockerfile.alpine|')),
        prerelease
      ).toBe(true);
    }
  });
});
