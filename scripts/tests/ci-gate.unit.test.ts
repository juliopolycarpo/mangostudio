import { describe, expect, test } from 'bun:test';

import { evaluateGate, parseAllowedSkips, parseNeeds } from '../ci/evaluate-gate';
import { readText } from './support/read-text';
import {
  expectedGateNeeds,
  extractJobBlock,
  extractJobBlocks,
  extractOnBlock,
  parseNeedsList,
  sectionKeys,
} from './support/workflow-blocks';

// CI gating policy: one authoritative run per PR commit, and one stable
// always-reporting Gate check per workflow that branch protection can require
// without tracking internal job names, matrix shapes, or path filters.

const GATED_WORKFLOWS = [
  '.github/workflows/ci.yml',
  '.github/workflows/cargo-shim.yml',
  '.github/workflows/release-dry-run.yml',
] as const;

const INTEGRATION_PR_WORKFLOWS = [
  '.github/workflows/ci.yml',
  '.github/workflows/cargo-shim.yml',
  '.github/workflows/codeql.yml',
  '.github/workflows/dependency-review.yml',
  '.github/workflows/protocol-ci.yml',
  '.github/workflows/release-dry-run.yml',
  '.github/workflows/vendor-drift.yml',
] as const;

// GitHub expression opener, assembled out of band so the literal `${{` never
// appears in a plain string — biome's noTemplateCurlyInString would flag it.
// Interpolating it into a template literal is not flagged.
const EXPR = '$' + '{{';

describe('Rust integration branch coverage', () => {
  test.each([...INTEGRATION_PR_WORKFLOWS])('%s runs for both protected PR targets', (path) => {
    const onBlock = extractOnBlock(readText(path));
    expect(onBlock).toContain('pull_request:\n    branches: [main, feat/rust-runtime]');
  });
});

describe('gate result evaluation', () => {
  const skips = parseAllowedSkips('qa-metrics');

  test('passes when every dependency succeeded', () => {
    const verdict = evaluateGate({ check: 'success', test: 'success' }, new Set());
    expect(verdict.ok).toBe(true);
  });

  test.each(['failure', 'cancelled', 'skipped'] as const)(
    'fails when a mandatory dependency result is %s',
    (result) => {
      const verdict = evaluateGate({ check: 'success', test: result }, new Set());
      expect(verdict.ok).toBe(false);
      expect(verdict.lines.join('\n')).toContain(`test: ${result}`);
    }
  );

  test('accepts a skip only for a declared conditional lane', () => {
    expect(evaluateGate({ check: 'success', 'qa-metrics': 'skipped' }, skips).ok).toBe(true);
    expect(evaluateGate({ check: 'success', 'qa-metrics': 'skipped' }, new Set()).ok).toBe(false);
  });

  test('a declared conditional lane that ran and failed still fails the gate', () => {
    expect(evaluateGate({ check: 'success', 'qa-metrics': 'failure' }, skips).ok).toBe(false);
  });

  test('one failure is not masked by other successes or accepted skips', () => {
    const verdict = evaluateGate(
      { check: 'success', test: 'failure', 'qa-metrics': 'skipped' },
      skips
    );
    expect(verdict.ok).toBe(false);
  });

  test('an empty needs context fails instead of passing vacuously', () => {
    expect(evaluateGate({}, new Set()).ok).toBe(false);
  });

  test('an allowed-skip job that is not a dependency is configuration drift', () => {
    const verdict = evaluateGate({ check: 'success' }, parseAllowedSkips('renamed-job'));
    expect(verdict.ok).toBe(false);
    expect(verdict.lines.join('\n')).toContain('renamed-job');
  });

  test('parseAllowedSkips splits on whitespace and commas and drops empties', () => {
    expect(parseAllowedSkips(' a  b,c ')).toEqual(new Set(['a', 'b', 'c']));
    expect(parseAllowedSkips('')).toEqual(new Set());
    expect(parseAllowedSkips(undefined)).toEqual(new Set());
  });

  test('parseNeeds reads the toJSON(needs) shape and rejects malformed input', () => {
    expect(parseNeeds('{"check":{"result":"success","outputs":{}}}')).toEqual({
      check: 'success',
    });
    expect(() => parseNeeds(undefined)).toThrow('NEEDS is required');
    expect(() => parseNeeds('not json')).toThrow('not valid JSON');
    expect(() => parseNeeds('[]')).toThrow('JSON object form');
    expect(() => parseNeeds('{"check":{}}')).toThrow('unrecognized result');
    expect(() => parseNeeds('{"check":{"result":"green"}}')).toThrow('unrecognized result');
  });
});

describe('ci.yml trigger and concurrency policy', () => {
  const workflow = readText('.github/workflows/ci.yml');

  /**
   * Any temporary long-lived-branch entry (the Bun frontend migration carried
   * one) has to come here and be justified, instead of quietly widening into a
   * branch allowlist.
   */
  test('runs for PRs to main and the Rust integration branch, pushes to main, and manual dispatch', () => {
    const onBlock = extractOnBlock(workflow);

    expect(sectionKeys(onBlock)).toEqual(['pull_request', 'push', 'workflow_dispatch']);
    expect(onBlock).toContain('pull_request:\n    branches: [main, feat/rust-runtime]');
    expect(onBlock).toContain('push:\n    branches: [main]');
    // No branch-prefix allowlist: development branches get CI via their PR.
    expect(onBlock).not.toContain('/**');
  });

  test('one authoritative run per PR: keyed by PR number, never by SHA', () => {
    expect(workflow).toContain(
      `group: ${EXPR} github.workflow }}-${EXPR} github.event_name == 'pull_request' && format('pr-{0}', github.event.pull_request.number) || github.ref }}`
    );
    // A new push must supersede the previous run — except on main, where every
    // push has to reach Canary.
    expect(workflow).toContain(`cancel-in-progress: ${EXPR} github.ref != 'refs/heads/main' }}`);
    expect(workflow).not.toContain('github.sha');
  });
});

describe('CI / Gate aggregate', () => {
  const workflow = readText('.github/workflows/ci.yml');
  const gateBlock = extractJobBlock(workflow, 'gate');

  test('needs every mandatory job, so new jobs cannot bypass it', () => {
    expect(extractJobBlocks(workflow).map(({ job }) => job)).toContain('gate');
    expect(parseNeedsList(gateBlock).sort()).toEqual(expectedGateNeeds(workflow));
  });

  test('gate accepts qa-metrics on workflow_dispatch and distribution skips when irrelevant', () => {
    // The placeholder count is pinned deliberately: `format` drops arguments it
    // has no slot for, so a fifth skip added without widening this would be
    // accepted silently and never allow the skip it was written for.
    expect(gateBlock).toContain(`ALLOWED_SKIPS: ${EXPR} format('{0} {1} {2} {3}',`);
    expect(gateBlock).toContain("github.event_name == 'workflow_dispatch' && 'qa-metrics'");
    expect(gateBlock).toContain("needs.changes.outputs.distribution == 'false' && 'distribution'");
    expect(gateBlock).toContain("needs.changes.outputs.distribution == 'false' && 'smoke'");
    expect(gateBlock).toContain(
      "needs.changes.outputs.distribution == 'false' && 'smoke-container'"
    );
  });

  test('the distribution and smoke lanes run only when the changes job says so', () => {
    const relevanceIf = `if: ${EXPR} needs.changes.outputs.distribution == 'true' }}`;
    for (const job of ['distribution', 'smoke', 'smoke-container']) {
      expect(extractJobBlock(workflow, job), job).toContain(relevanceIf);
    }
  });

  test('no lane fetches a cross-compile runtime while .bun-version is pinned', () => {
    // The `cross-runtimes` lane and `cross-runtime-nightly.yml` verified a
    // download path that only exists on a channel. Against a released pin
    // `verify-cross-runtimes.ts` prints "nothing to verify" and exits 0, so
    // both lanes were spending a runner to assert nothing. Restoring them is
    // part of moving `.bun-version` back to a channel, not a standalone change.
    expect(extractJobBlocks(workflow).map(({ job }) => job)).not.toContain('cross-runtimes');
    expect(workflow).not.toContain('verify-cross-runtimes.ts');
    expect(workflow).not.toContain('cross_runtime');
  });

  test('non-pull_request events treat every lane as relevant', () => {
    expect(workflow).toContain('if [ "$EVENT_NAME" != "pull_request" ]');
  });

  test('an empty PR diff fails closed instead of skipping distribution', () => {
    expect(workflow).toContain('if [ ! -s "$RUNNER_TEMP/changed-files" ]; then');
    expect(workflow).toContain('refusing to skip distribution');
  });

  test('relevance detection cannot silently fail open', () => {
    // Renames must list both sides, or moving a source file under an
    // irrelevant path would hide the source-side deletion.
    expect(workflow).toContain('git diff --no-renames --name-only');
    // A single grep, never `grep … | grep -q .`: under `set -o pipefail` the
    // producer dies of SIGPIPE on a large diff and the non-zero pipeline
    // status reads as "no relevant paths changed".
    expect(workflow).toContain('if grep -Eqv "$irrelevant" "$RUNNER_TEMP/changed-files"; then');
  });
});

describe('cargo-shim.yml always-reporting Rust workspace gate', () => {
  const workflow = readText('.github/workflows/cargo-shim.yml');

  test('triggers on every PR; only the push trigger keeps a path filter', () => {
    const onBlock = extractOnBlock(workflow);

    expect(sectionKeys(onBlock)).toEqual(['pull_request', 'push', 'workflow_dispatch']);
    // pull_request must not be path-filtered, or the Gate check would hang as
    // "expected" on non-Rust PRs.
    expect(onBlock).toContain('pull_request:\n    branches: [main, feat/rust-runtime]\n  push:');
    expect(onBlock).toContain('- "crates/**"');
    expect(onBlock).toContain('- "Cargo.toml"');
    expect(onBlock).toContain('- "Cargo.lock"');
  });

  test('the push filter and the changes job both cover every ts-home fixture input', () => {
    // `runtime-home-fixture-freshness`'s ts-home half depends on these
    // TypeScript-side paths; a PR touching only one of them must still run
    // this workflow, or that job's regenerate-and-diff step never executes
    // and ts-home goes stale silently.
    const onBlock = extractOnBlock(workflow);
    const changesBlock = extractJobBlock(workflow, 'changes');
    const tsHomeInputs = [
      'apps/shared/src/runtime-home/',
      'apps/shared/src/external-agents/',
      'apps/shared/src/schema-helpers.ts',
      'apps/shared/src/environments/toolchain-schemas.ts',
      // The whole runtime tree: ts-home reads runtime-home.ts and config.ts,
      // and the Rust/TypeScript parity lanes drive the in-process runtime.
      'apps/runtime/src/',
      'apps/runtime/scripts/generate-home-fixtures.ts',
      'apps/runtime/package.json',
    ];

    for (const input of tsHomeInputs) {
      expect(onBlock).toContain(`"${input}${input.endsWith('/') ? '**' : ''}"`);
      const escaped = input.replaceAll('.', String.raw`\.`);
      expect(changesBlock).toContain(escaped);
    }
  });

  test('the workspace and launcher MSRV lanes run only when the changes job saw a Rust path', () => {
    const workspaceBlock = extractJobBlock(workflow, 'workspace');
    const msrvBlock = extractJobBlock(workflow, 'launcher-msrv');

    expect(parseNeedsList(workspaceBlock)).toEqual(['changes']);
    expect(parseNeedsList(msrvBlock)).toEqual(['changes']);
    expect(workspaceBlock).toContain("if: needs.changes.outputs.rust == 'true'");
    expect(msrvBlock).toContain("if: needs.changes.outputs.rust == 'true'");
    expect(workspaceBlock).toContain('os: [ubuntu-latest, macos-latest, windows-latest]');
    expect(msrvBlock).toContain('components: clippy');
    expect(msrvBlock).toContain('cargo check -p mangostudio --all-targets --locked');
    expect(msrvBlock).toContain(
      'cargo clippy -p mangostudio --all-targets --locked -- -D warnings'
    );
    expect(msrvBlock).toContain('cargo test -p mangostudio --all-targets --locked');
  });

  test('the musl clippy lane fails on musl-only warnings for both shipped musl targets', () => {
    const muslBlock = extractJobBlock(workflow, 'musl-clippy');

    expect(parseNeedsList(muslBlock)).toEqual(['changes']);
    expect(muslBlock).toContain("if: needs.changes.outputs.rust == 'true'");
    expect(muslBlock).toContain('uses: ./.github/actions/setup-zigbuild');
    for (const triple of ['x86_64-unknown-linux-musl', 'aarch64-unknown-linux-musl']) {
      expect(muslBlock).toContain(
        `cargo-zigbuild clippy --locked -p mangostudio-runtime --all-targets --target ${triple} -- -D warnings`
      );
    }
  });

  test('the fixture freshness lane regenerates and diffs both rust-home and ts-home', () => {
    const freshnessBlock = extractJobBlock(workflow, 'runtime-home-fixture-freshness');

    // Regenerate, then stage before diffing against `HEAD` — a plain
    // `git diff --exit-code` against the worktree would miss a brand-new
    // file either regenerator started emitting.
    expect(freshnessBlock).toContain(
      'cargo test -p mangostudio-runtime --test generate_rust_fixture --locked -- --ignored'
    );
    expect(freshnessBlock).toContain(
      'git add -A -- crates/mangostudio-runtime/tests/fixtures/rust-home'
    );
    expect(freshnessBlock).toContain(
      'git diff --cached --exit-code -- crates/mangostudio-runtime/tests/fixtures/rust-home'
    );
    expect(freshnessBlock).toContain('bun run --filter @mangostudio/runtime fixtures:home');
    expect(freshnessBlock).toContain(
      'git add -A -- crates/mangostudio-runtime/tests/fixtures/ts-home'
    );
    expect(freshnessBlock).toContain(
      'git diff --cached --exit-code -- crates/mangostudio-runtime/tests/fixtures/ts-home'
    );
  });

  test('gate needs every mandatory job and accepts the Rust skip only when irrelevant', () => {
    const gateBlock = extractJobBlock(workflow, 'gate');

    expect(parseNeedsList(gateBlock).sort()).toEqual(expectedGateNeeds(workflow));
    expect(gateBlock).toContain(
      `ALLOWED_SKIPS: ${EXPR} needs.changes.outputs.rust == 'false' && 'workspace launcher-msrv musl-clippy fuzz-workspace runtime-home-fixture-freshness real-binary-qualification' || '' }}`
    );
  });

  test('the real-binary-qualification job builds and points at the binary its own suite requires', () => {
    // apps/api/tests/support/rust-runtime-binary.ts's fallback stays quiet
    // when MANGOSTUDIO_RUNTIME_BINARY is unset (the ordinary test.yml lane
    // never sets it and never builds Rust, on purpose) -- so the one place
    // that can catch this job forgetting to build the binary or wire the
    // override is this static check on the job definition itself, not a
    // runtime check inside the suite that cannot tell "an unrelated lane"
    // from "this job, misconfigured" apart.
    const qualificationBlock = extractJobBlock(workflow, 'real-binary-qualification');
    const binarySupport = readText('apps/api/tests/support/rust-runtime-binary.ts');

    expect(qualificationBlock).toContain('os: [ubuntu-latest, macos-latest, windows-latest]');
    expect(qualificationBlock).toContain(`runs-on: ${EXPR} matrix.os }}`);
    expect(qualificationBlock).toContain('cargo build -p mangostudio-runtime --locked');
    expect(qualificationBlock).toContain(
      `MANGOSTUDIO_RUNTIME_BINARY: ${EXPR} github.workspace }}/${EXPR} matrix.runtime-binary }}`
    );
    expect(qualificationBlock).toContain('runtime-binary: target/debug/mangostudio-runtime.exe');
    expect(binarySupport).toContain("process.platform === 'win32' ? 'mangostudio-runtime.exe'");
    // The stand-in vendor, built on its own so the runtime binary never gains
    // the SDK's `testing` feature, and pointed at so its absence fails loudly.
    expect(qualificationBlock).toContain(
      'cargo build -p mangostudio-runtime --example fake_cursor_agent --locked'
    );
    expect(qualificationBlock.indexOf('--example fake_cursor_agent')).toBeGreaterThan(
      qualificationBlock.indexOf('cargo build -p mangostudio-runtime --locked')
    );
    expect(qualificationBlock).toContain(
      `MANGOSTUDIO_FAKE_CURSOR_AGENT: ${EXPR} github.workspace }}/${EXPR} matrix.fake-cursor-agent }}`
    );
    expect(qualificationBlock).toContain(
      'fake-cursor-agent: target/debug/examples/fake_cursor_agent.exe'
    );
    expect(qualificationBlock).toContain(
      'tests/integration/services/rust-runtime-qualification.integration.test.ts'
    );
    expect(qualificationBlock).toContain(
      'tests/integration/services/rust-runtime-external-agents-qualification.integration.test.ts'
    );
    expect(qualificationBlock).toContain(
      'tests/integration/services/rust-filesystem-search-compat.integration.test.ts'
    );
    expect(qualificationBlock).toContain(
      'tests/integration/services/rust-snapshot-compat.integration.test.ts'
    );
    expect(qualificationBlock).toContain(
      'tests/integration/services/rust-command-compat.integration.test.ts'
    );
    expect(qualificationBlock).toContain(
      'tests/integration/routes/rust-runtime-qualification-connect.integration.test.ts'
    );
  });
});

describe('release-dry-run.yml always-reporting gate', () => {
  const workflow = readText('.github/workflows/release-dry-run.yml');

  test('triggers on every PR without a path filter, plus schedule and dispatch', () => {
    const onBlock = extractOnBlock(workflow);

    expect(sectionKeys(onBlock)).toEqual(['pull_request', 'workflow_dispatch', 'schedule']);
    expect(onBlock).toContain(
      'pull_request:\n    branches: [main, feat/rust-runtime]\n  workflow_dispatch:'
    );
  });

  test('each dry-run lane runs only when its relevance predicate is true', () => {
    const linuxBlock = extractJobBlock(workflow, 'dry-run-linux');
    const windowsBlock = extractJobBlock(workflow, 'dry-run-windows');
    const cargoBlock = extractJobBlock(workflow, 'dry-run-cargo');
    const runtimeBlock = extractJobBlock(workflow, 'runtime');

    // The cargo runtimes both dry-run archives ship come from the runtime lane,
    // which is relevant exactly when the Linux lane is.
    expect(parseNeedsList(runtimeBlock)).toEqual(['changes']);
    expect(runtimeBlock).toContain("if: needs.changes.outputs.release == 'true'");
    expect(parseNeedsList(linuxBlock)).toEqual(['changes', 'runtime']);
    expect(linuxBlock).toContain("if: needs.changes.outputs.release == 'true'");
    // Also needs `changes` directly (not just transitively through
    // dry-run-linux) so its own `if:` can read `needs.changes.outputs`.
    expect(parseNeedsList(windowsBlock)).toEqual(['changes', 'dry-run-linux']);
    expect(windowsBlock).toContain("if: needs.changes.outputs.release == 'true'");
    expect(parseNeedsList(cargoBlock)).toEqual(['changes']);
    expect(cargoBlock).toContain("if: needs.changes.outputs.launcher == 'true'");
    expect(cargoBlock).toContain('RUSTUP_TOOLCHAIN: 1.96.0');
  });

  test('non-PR events treat every lane as relevant (weekly drift check)', () => {
    expect(workflow).toContain('if [ "$EVENT_NAME" != "pull_request" ]; then');
    expect(workflow).toContain('echo "release=true" >> "$GITHUB_OUTPUT"');
  });

  test('gate needs every mandatory job and accepts each lane skip only when irrelevant', () => {
    const gateBlock = extractJobBlock(workflow, 'gate');

    expect(parseNeedsList(gateBlock).sort()).toEqual(expectedGateNeeds(workflow));
    expect(gateBlock).toContain(
      `ALLOWED_SKIPS: ${EXPR} format('{0} {1} {2} {3}', needs.changes.outputs.release == 'false' && 'dry-run-linux' || '', needs.changes.outputs.launcher == 'false' && 'dry-run-cargo' || '', needs.changes.outputs.release == 'false' && 'dry-run-windows' || '', needs.changes.outputs.release == 'false' && 'runtime' || '') }}`
    );
  });
});

describe('shared gate job contract', () => {
  test.each([...GATED_WORKFLOWS])('%s gate always runs the tested evaluator', (path) => {
    const workflow = readText(path);
    const gateBlock = extractJobBlock(workflow, 'gate');
    expect(gateBlock, `gate job not found in ${path}`).not.toBe('');

    // Runs regardless of dependency outcomes, else a failure would skip the
    // check instead of failing it; evaluation happens in the unit-tested
    // script, not a YAML expression.
    expect(gateBlock).toContain(`if: ${EXPR} always() }}`);
    expect(gateBlock).toContain('name: Gate');
    expect(gateBlock).toContain('permissions:\n      contents: read');
    expect(gateBlock).toContain(`NEEDS: ${EXPR} toJSON(needs) }}`);
    expect(gateBlock).toContain('run: bun ./scripts/ci/evaluate-gate.ts');
  });

  test.each([...GATED_WORKFLOWS])(
    '%s gate needs includes changes when the workflow has a changes job',
    (path) => {
      const workflow = readText(path);
      const jobs = extractJobBlocks(workflow).map(({ job }) => job);
      if (!jobs.includes('changes')) {
        return;
      }

      // Skip predicates read outputs from `changes`; dangling ALLOWED_SKIPS
      // would silently accept the wrong lanes if it dropped out of needs.
      expect(expectedGateNeeds(workflow)).toContain('changes');
      expect(parseNeedsList(extractJobBlock(workflow, 'gate'))).toContain('changes');
    }
  );

  test('expectedGateNeeds picks up a synthetic job that is not gated', () => {
    const base = readText('.github/workflows/cargo-shim.yml');
    const withOrphan = `${base}\n  orphan-lane:\n    runs-on: ubuntu-latest\n    steps:\n      - run: 'true'\n`;

    expect(expectedGateNeeds(withOrphan)).toContain('orphan-lane');
    expect(parseNeedsList(extractJobBlock(withOrphan, 'gate')).sort()).not.toEqual(
      expectedGateNeeds(withOrphan)
    );
  });

  test('expectedGateNeeds excludes jobs that already depend on the gate', () => {
    const base = readText('.github/workflows/ci.yml');
    expect(expectedGateNeeds(base)).not.toContain('canary');
    expect(expectedGateNeeds(base)).not.toContain('gate');
  });
});
