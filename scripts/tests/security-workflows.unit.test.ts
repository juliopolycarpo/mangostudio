import { describe, expect, test } from 'bun:test';

import { readText } from './support/read-text';
import { extractJobBlocks, extractStepBlocks } from './support/workflow-blocks';

/** Every step of every job in a workflow, as isolated blocks. */
function workflowSteps(workflow: string): string[] {
  return extractJobBlocks(workflow).flatMap(({ block }) => extractStepBlocks(block));
}

function expectWorkflowHasPinnedAction(workflow: string, action: string): void {
  const escapedAction = action.replaceAll('/', String.raw`\/`);
  expect(workflow).toMatch(new RegExp(`uses: ${escapedAction}@[a-f0-9]{40} # v\\d`));
}

interface DependabotConfig {
  updates: Array<{
    'package-ecosystem': string;
    ignore?: Array<{ 'dependency-name': string; versions?: string[] }>;
  }>;
}

describe('security workflows', () => {
  test('CodeQL uses explicit advanced setup for the repository languages', () => {
    const workflow = readText('.github/workflows/codeql.yml');
    const languageExpression = '$' + '{{ matrix.language }}';
    expect(workflow).toContain(`languages: ${languageExpression}`);

    expect(workflow).toContain('pull_request:\n    branches: [main]');
    expect(workflow).toContain('push:\n    branches: [main]');
    expect(workflow).toContain('schedule:');
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('permissions:\n  contents: read');
    expect(workflow).toContain('security-events: write');

    expect(workflow).toContain('language: javascript-typescript');
    expect(workflow).toContain('language: rust');
    expect(workflow).toContain('build-mode: none');
    expect(workflow).toContain('queries: security-extended');
    expect(workflow).toContain('category: "/language:javascript-typescript"');
    expect(workflow).toContain('category: "/language:rust"');
    expect(workflow).toContain('os: windows-latest');
    expect(workflow).toContain('label: rust, windows');
    expect(workflow).toContain('category: "/language:rust/windows"');
    expect(workflow).not.toContain('autobuild');
    expect(workflow).not.toContain('setup-mango');
    expectWorkflowHasPinnedAction(workflow, 'github/codeql-action/init');
    expectWorkflowHasPinnedAction(workflow, 'github/codeql-action/analyze');
  });

  test('dependency review is a PR-only vulnerability gate with no license policy', () => {
    const workflow = readText('.github/workflows/dependency-review.yml');

    expect(workflow).toContain('pull_request:\n    branches: [main]');
    expect(workflow).not.toContain('push:');
    expect(workflow).toContain('permissions:\n  contents: read');
    expect(workflow).toContain('fail-on-severity: moderate');
    expect(workflow).toContain('license-check: false');
    expectWorkflowHasPinnedAction(workflow, 'actions/dependency-review-action');
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

  test('publish-path distribution downloads verify provenance; PR-path downloads do not', () => {
    for (const file of ['.github/workflows/release.yml', '.github/workflows/canary.yml']) {
      // Per step, never a byte window around the `uses:` line: a fixed slice
      // straddles neighbouring steps, so a call missing the flag could be
      // satisfied by the next call's text.
      const downloads = workflowSteps(readText(file)).filter((step) =>
        step.includes('uses: ./.github/actions/download-distribution')
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
    const config = readText('.github/dependabot.yml');
    // The unified Cargo workspace publishes the launcher and enforces its root
    // lockfile with --locked; without a cargo entry nothing ever updates it. Docker base
    // images ship on every release and need the same coverage.
    for (const ecosystem of ['github-actions', 'bun', 'cargo', 'docker']) {
      expect(config).toContain(`package-ecosystem: ${ecosystem}`);
    }

    const bunBlock = config.split('package-ecosystem:').find((block) => block.startsWith(' bun'));
    expect(bunBlock).toBeDefined();
    expect(bunBlock).toContain('interval: weekly');
    expect(bunBlock).toContain('dev-minor-patch:');
    expect(bunBlock).toContain('prod-minor-patch:');
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
