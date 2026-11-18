import { describe, expect, test } from 'bun:test';

import { readText } from './support/read-text';
import {
  extractJobBlock,
  extractJobBlocks,
  extractOnBlock,
  extractStepBlock,
  extractStepBlocks,
  extractStepBlocksUsing,
  extractTopLevelBlock,
  sectionKeys,
} from './support/workflow-blocks';

/** Every step of every job in a workflow, as isolated blocks. */
function workflowSteps(workflow: string): string[] {
  return extractJobBlocks(workflow).flatMap(({ block }) => extractStepBlocks(block));
}

/**
 * Assert the one step that runs `action` inside `jobBlock` pins it to a full
 * commit SHA with a version comment, and return that step for further checks.
 * Scoped to a job: another job pinning the same action does not count.
 */
function expectJobHasPinnedAction(jobBlock: string, action: string): string {
  const steps = extractStepBlocksUsing(jobBlock, action);
  expect(steps, `expected one step running ${action} | received: ${steps.length}`).toHaveLength(1);
  const escapedAction = action.replaceAll('/', String.raw`\/`);
  expect(steps[0]).toMatch(new RegExp(`uses: ${escapedAction}@[a-f0-9]{40} # v\\d`));
  return steps[0];
}

interface DependabotConfig {
  updates: Array<{
    'package-ecosystem': string;
    schedule?: { interval: string; day?: string };
    cooldown?: { 'default-days'?: number; 'semver-major-days'?: number };
    groups?: Record<string, { patterns?: string[]; 'update-types'?: string[] }>;
    ignore?: Array<{ 'dependency-name': string; versions?: string[] }>;
  }>;
}

describe('security workflows', () => {
  test('CodeQL uses explicit advanced setup for the repository languages', () => {
    const workflow = readText('.github/workflows/codeql.yml');
    const languageExpression = '$' + '{{ matrix.language }}';
    const triggers = extractOnBlock(workflow);

    expect(sectionKeys(triggers)).toEqual([
      'pull_request',
      'push',
      'schedule',
      'workflow_dispatch',
    ]);
    expect(triggers).toContain('pull_request:\n    branches: [main, "stack/**"]');
    expect(triggers).toContain('push:\n    branches: [main]');
    const permissions = extractTopLevelBlock(workflow, 'permissions');
    expect(permissions).toMatch(/^ {2}contents: read$/m);
    // The SARIF upload grant belongs to the analysis jobs, never to the whole workflow.
    expect(permissions).not.toContain('security-events');

    // Each analysis job carries its own grant, matrix and pinned init/analyze pair; a sibling
    // job's copy of the same line does not configure this one.
    const matrixByJob = {
      analyze: ['language: javascript-typescript', 'category: "/language:javascript-typescript"'],
      'analyze-rust': [
        'language: rust',
        'category: "/language:rust"',
        'os: windows-latest',
        'label: rust, windows',
        'category: "/language:rust/windows"',
      ],
    };
    for (const [job, lines] of Object.entries(matrixByJob)) {
      const block = extractJobBlock(workflow, job);
      expect(block, `${job}: job-level security-events grant`).toMatch(
        /^ {6}security-events: write #/m
      );
      for (const line of [...lines, 'build-mode: none', 'queries: security-extended']) {
        expect(block, `${job}: matrix entry ${line}`).toContain(line);
      }
      const init = expectJobHasPinnedAction(block, 'github/codeql-action/init');
      expect(init, `${job}: init languages`).toContain(`languages: ${languageExpression}`);
      expectJobHasPinnedAction(block, 'github/codeql-action/analyze');
    }
    expect(workflow).not.toContain('autobuild');
    expect(workflow).not.toContain('setup-mango');
  });

  test('CodeQL always analyzes JavaScript and gates only the Rust legs on pull requests', () => {
    const workflow = readText('.github/workflows/codeql.yml');
    const blocks = Object.fromEntries(
      extractJobBlocks(workflow).map(({ job, block }) => [job, block])
    );
    expect(Object.keys(blocks).sort()).toEqual(['analyze', 'analyze-rust', 'changes']);

    // The required code scanning check needs an analysis on every pull
    // request, so the JavaScript leg must not wait for or depend on the gate.
    expect(blocks.analyze).not.toContain('needs:');
    expect(blocks.analyze).not.toMatch(/^ {4}if:/m);
    expect(blocks.analyze).toContain('language: javascript-typescript');
    expect(blocks.analyze).not.toContain('language: rust');

    expect(blocks['analyze-rust']).toContain('needs: [changes]');
    expect(blocks['analyze-rust']).toContain("if: needs.changes.outputs.rust == 'true'");
    expect(blocks['analyze-rust']).not.toContain('language: javascript-typescript');

    // Every event that is not a pull request analyzes all legs: main is the
    // baseline, and Canary qualification requires the three analyses there.
    expect(blocks.changes).toContain(
      'if [ "$EVENT_NAME" != "pull_request" ]; then\n            echo "rust=true" >> "$GITHUB_OUTPUT"'
    );
    expect(blocks.changes).toContain('bun ./scripts/ci/changed-paths.ts codeql');
  });

  test('dependency review is a PR-only vulnerability gate with no license policy', () => {
    const workflow = readText('.github/workflows/dependency-review.yml');

    expect(extractOnBlock(workflow)).toContain('pull_request:\n    branches: [main, "stack/**"]');
    expect(sectionKeys(extractOnBlock(workflow))).toEqual(['pull_request']);
    expect(workflow).not.toContain('push:');
    expect(extractTopLevelBlock(workflow, 'permissions')).toMatch(/^ {2}contents: read$/m);
    const review = expectJobHasPinnedAction(
      extractJobBlock(workflow, 'dependency-review'),
      'actions/dependency-review-action'
    );
    expect(review).toContain('fail-on-severity: moderate');
    expect(review).toContain('license-check: false');
  });

  test('contributor and security docs describe the bot-facing security checks', () => {
    const contributing = readText('.github/CONTRIBUTING.md');
    const security = readText('.github/SECURITY.md');

    for (const doc of [contributing, security]) {
      expect(doc).toContain('.github/workflows/codeql.yml');
      expect(doc).toContain('.github/workflows/dependency-review.yml');
      expect(doc).toContain('security-extended');
      expect(doc).toContain('Code scanning results / CodeQL');
      expect(doc).toContain('Rust');
      expect(doc).toContain('Dependency Review');
    }
  });

  test('publish-path distribution downloads require the shipping runtime profile', () => {
    for (const file of ['.github/workflows/release.yml', '.github/workflows/canary.yml']) {
      const downloads = workflowSteps(readText(file)).filter((step) =>
        /uses: [.$]\/\.github\/actions\/download-distribution\b/.test(step)
      );
      expect(downloads.length, file).toBeGreaterThan(0);
      for (const step of downloads) {
        expect(step, file).toContain('runtime-profile: shipping');
      }
    }
    const action = readText('.github/actions/download-distribution/action.yml');
    expect(extractStepBlock(action, 'Verify distribution identity and checksums', 4)).toContain(
      '--runtime-profile "$EXPECTED_RUNTIME_PROFILE"'
    );
  });

  test('publish-path distribution downloads verify provenance; PR-path downloads do not', () => {
    for (const file of ['.github/workflows/release.yml', '.github/workflows/canary.yml']) {
      // Per step, never a byte window around the `uses:` line: a fixed slice
      // straddles neighbouring steps, so a call missing the flag could be
      // satisfied by the next call's text.
      const downloads = workflowSteps(readText(file)).filter((step) =>
        /uses: [.$]\/\.github\/actions\/download-distribution\b/.test(step)
      );
      expect(downloads.length, file).toBeGreaterThan(0);
      for (const step of downloads) {
        expect(step, file).toContain('verify-attestation: "true"');
      }
    }
    const smoke = readText('.github/workflows/smoke-binary.yml');
    expect(smoke).not.toContain('verify-attestation');
  });

  test('attestation is produced for exactly the events that are later verified', () => {
    const attest = workflowSteps(readText('.github/workflows/distribution-build.yml')).filter(
      (step) => step.includes('uses: actions/attest-build-provenance@')
    );
    expect(attest).toHaveLength(1);
    expect(attest[0]).toContain("if: github.event_name != 'pull_request'");
  });

  test('every shipped dependency ecosystem is covered by Dependabot', () => {
    const config = Bun.YAML.parse(readText('.github/dependabot.yml')) as DependabotConfig;
    const ecosystems = config.updates.map((update) => update['package-ecosystem']);
    // The unified Cargo workspace publishes the launcher and enforces its root
    // lockfile with --locked; without a cargo entry nothing ever updates it. Docker base
    // images ship on every release and need the same coverage.
    for (const ecosystem of ['github-actions', 'bun', 'cargo', 'docker']) {
      expect(ecosystems, `dependabot.yml update entries`).toContain(ecosystem);
    }

    // Read from the bun entry itself: the other ecosystems also declare weekly schedules.
    const bunUpdate = config.updates.find((update) => update['package-ecosystem'] === 'bun');
    expect(bunUpdate?.schedule?.interval).toBe('weekly');
    expect(Object.keys(bunUpdate?.groups ?? {})).toEqual(
      expect.arrayContaining(['dev-minor-patch', 'prod-minor-patch'])
    );
  });

  test('Dependabot waits at least as long as the Cargo publish-age hold before a cargo bump', () => {
    const cargoConfig = readText('.cargo/config.toml');
    const hold = /^global-min-publish-age = "(\d+) days"$/m.exec(cargoConfig);
    expect(hold, 'global-min-publish-age missing from .cargo/config.toml').not.toBeNull();
    const config = Bun.YAML.parse(readText('.github/dependabot.yml')) as DependabotConfig;
    const cargo = config.updates.find((update) => update['package-ecosystem'] === 'cargo');
    // A shorter Dependabot cooldown would propose versions that the
    // repository's own `cargo update` skips.
    expect(cargo?.cooldown?.['default-days']).toBeGreaterThanOrEqual(Number(hold?.[1]));
  });

  test('Dependabot opens one weekly pull request for action bumps outside the CodeQL pair', () => {
    const config = Bun.YAML.parse(readText('.github/dependabot.yml')) as DependabotConfig;
    const actions = config.updates.find(
      (update) => update['package-ecosystem'] === 'github-actions'
    );

    // A daily ungrouped schedule opened one PR per directory per release, and
    // each PR runs every CI lane. Weekly without a day means Monday, the
    // morning the bun, cargo and docker updates already open theirs.
    expect(actions?.schedule).toMatchObject({ interval: 'weekly', day: 'wednesday' });

    // Dependabot assigns a dependency to the first group whose patterns match,
    // so the catch-all has to come after the codeql-action pair, and that
    // group's own pattern must stay narrow or it would absorb everything.
    const groups = Object.entries(actions?.groups ?? {});
    expect(groups.map(([name]) => name)).toEqual(['codeql-action', 'setup-bun', 'actions']);
    // No update-types on the pair: init and analyze move together on a major too.
    expect(groups[0]?.[1]).toEqual({ patterns: ['github/codeql-action*'] });
    // One pin shared across two directories: a split bump fails the shared-pin
    // test, so majors must stay grouped here as well.
    expect(groups[1]?.[1]).toEqual({ patterns: ['oven-sh/setup-bun'] });
    // A major must not ride in with the week's patches.
    expect(groups.at(-1)?.[1]).toEqual({
      patterns: ['*'],
      'update-types': ['minor', 'patch'],
    });
  });

  test('Dependabot allows TypeBox updates after the Elysia compiler compatibility fix', () => {
    const config = Bun.YAML.parse(readText('.github/dependabot.yml')) as {
      updates: Array<{
        'package-ecosystem': string;
        ignore?: Array<{ 'dependency-name': string; 'update-types'?: string[] }>;
      }>;
    };
    const bunUpdates = config.updates.find((update) => update['package-ecosystem'] === 'bun');
    const typeboxIgnore = bunUpdates?.ignore?.find((rule) => rule['dependency-name'] === 'typebox');

    expect(typeboxIgnore).toBeUndefined();
  });

  test('Dependabot skips Elysia 2.0.0-exp builds only while Elysia 2 is in prerelease', () => {
    const api = JSON.parse(readText('apps/api/package.json')) as {
      dependencies: { elysia: string };
    };
    const config = Bun.YAML.parse(readText('.github/dependabot.yml')) as DependabotConfig;
    const bunUpdates = config.updates.find((update) => update['package-ecosystem'] === 'bun');
    const expIgnores = (bunUpdates?.ignore ?? []).filter((rule) =>
      ['elysia', '@elysia/*'].includes(rule['dependency-name'])
    );

    expect(expIgnores.map((rule) => rule['dependency-name'])).toEqual(['elysia', '@elysia/*']);
    // Stale-rule tripwire: once elysia is pinned to a stable release, delete both
    // exp ignore rules from .github/dependabot.yml and this test.
    expect(api.dependencies.elysia).toMatch(/^2\.0\.0-/);

    for (const rule of expIgnores) {
      const [range] = rule.versions ?? [];
      expect(range).toBeDefined();
      expect(Bun.semver.satisfies('2.0.0-exp.64', range as string)).toBe(true);
      expect(Bun.semver.satisfies('2.0.0-beta.19', range as string)).toBe(false);
      expect(Bun.semver.satisfies('2.0.0-rc.0', range as string)).toBe(false);
      expect(Bun.semver.satisfies('2.0.0', range as string)).toBe(false);
    }
  });

  test('Dependabot holds sse-stream at 0.2 only while rmcp resolves sse-stream 0.2', () => {
    const config = Bun.YAML.parse(readText('.github/dependabot.yml')) as DependabotConfig;
    const cargoUpdates = config.updates.find((update) => update['package-ecosystem'] === 'cargo');
    const sseIgnore = cargoUpdates?.ignore?.find(
      (rule) => rule['dependency-name'] === 'sse-stream'
    );
    expect(sseIgnore?.versions).toEqual(['>=0.3.0']);

    const lock = Bun.TOML.parse(readText('Cargo.lock')) as {
      package: Array<{ name: string; version: string }>;
    };
    const sseVersions = lock.package
      .filter((pkg) => pkg.name === 'sse-stream')
      .map((pkg) => pkg.version);
    // Stale-rule tripwire: an sse-stream 0.3 in Cargo.lock means rmcp moved to it.
    // Delete the ignore rule from .github/dependabot.yml and bump the direct dependency.
    expect(sseVersions.filter((version) => !version.startsWith('0.2.'))).toEqual([]);
  });

  test('the launcher has a classification label glob', () => {
    expect(readText('.github/labeler.yml')).toContain('crates/mangostudio-launcher/**');
  });
});
