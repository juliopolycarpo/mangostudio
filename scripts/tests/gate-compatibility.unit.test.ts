import { describe, expect, test } from 'bun:test';

import { evaluateGate, type NeedResult, parseAllowedSkips, parseNeeds } from '../ci/evaluate-gate';
import fixtures from './support/gate-cases.json';
import { readText } from './support/read-text';
import {
  expectedGateNeeds,
  extractJobBlock,
  extractJobBlocks,
  extractOnBlock,
  extractStepBlocks,
  parseNeedsList,
} from './support/workflow-blocks';

const EXPR = '$' + '{{';
const PRODUCERS = ['gate', 'gate-unique'] as const;

interface Scenario {
  name: string;
  event: string;
  outputs: Readonly<Record<string, string | undefined>>;
  allowedSkips: readonly string[];
  reuseDistribution?: boolean;
}

function isReusableDryRun(workflow: string): boolean {
  return extractOnBlock(workflow).includes('  workflow_call:');
}

function scenarioProjection(path: string, workflow: string, scenario: Scenario): Scenario {
  const removed = new Set<string>();
  const added = new Set<string>();
  let reuseDistribution = false;
  if (path === '.github/workflows/cargo-shim.yml' && !extractJobBlock(workflow, 'fuzz-workspace')) {
    const workspace = extractJobBlock(workflow, 'workspace');
    const metadata = extractStepBlocks(workspace).find((step) =>
      step.includes(
        'run: cargo metadata --manifest-path crates/mango-protocol/fuzz/Cargo.toml --locked --all-features --format-version 1 > /dev/null'
      )
    );
    expect(metadata).toContain(
      `if: ${EXPR} !cancelled() && matrix.os == 'ubuntu-latest' && steps.toolchain.outcome == 'success' }}`
    );
    expect(metadata).not.toContain('continue-on-error');
    removed.add('fuzz-workspace');
  }
  if (path === '.github/workflows/protocol-ci.yml') {
    if (!extractJobBlock(workflow, 'package')) {
      const packageStep = extractStepBlocks(extractJobBlock(workflow, 'typescript')).find((step) =>
        step.includes('run: bun ./scripts/protocol/verify-package.ts')
      );
      expect(packageStep).toContain(
        `if: ${EXPR} !cancelled() && steps.install.outcome == 'success' }}`
      );
      expect(packageStep).not.toContain('continue-on-error');
      removed.add('package');
    }
    if (!extractJobBlock(workflow, 'transports')) {
      const interop = extractJobBlock(workflow, 'interop');
      expect(interop).toContain('os: [ubuntu-latest, macos-latest, windows-latest]');
      const transport = extractStepBlocks(interop).find((step) =>
        step.includes('run: bun run protocol:test --ts-only')
      );
      expect(transport).toContain(
        `if: ${EXPR} !cancelled() && steps.install.outcome == 'success' && matrix.os != 'ubuntu-latest' }}`
      );
      expect(transport).not.toContain('continue-on-error');
      removed.add('transports');
    }
  }
  if (path === '.github/workflows/ci.yml' && extractJobBlock(workflow, 'release-dry-run')) {
    const caller = extractJobBlock(workflow, 'release-dry-run');
    expect(caller).toContain('uses: ./.github/workflows/release-dry-run.yml');
    expect(caller).toContain(`if: ${EXPR} !cancelled() && github.event_name == 'pull_request' }}`);
    if (scenario.event !== 'pull_request') added.add('release-dry-run');
  }
  if (path === '.github/workflows/release-dry-run.yml' && isReusableDryRun(workflow)) {
    const caller = extractJobBlock(readText('.github/workflows/ci.yml'), 'release-dry-run');
    expect(caller).toContain('reuse_distribution: true');
    reuseDistribution = scenario.event === 'pull_request';
    if (reuseDistribution) added.add('runtime');
  }
  return {
    ...scenario,
    reuseDistribution,
    allowedSkips: [
      ...new Set([...scenario.allowedSkips.filter((job) => !removed.has(job)), ...added]),
    ].sort(),
  };
}

function skipExpression(block: string): string {
  const expression = /ALLOWED_SKIPS: \$\{\{\s*([\s\S]*?)\s*\}\}/.exec(block)?.[1];
  if (!expression) throw new Error('gate must declare ALLOWED_SKIPS');
  return expression;
}

// Evaluate only the literal comparison/format grammar used by these gates.
// Unknown syntax fails the test, so adding a skip rule requires a new fixture.
function skipsForCase(block: string, scenario: Scenario): Set<string> {
  const expression = skipExpression(block);
  const formatted = /^format\('([^']*)',\s*([\s\S]*)\)$/.exec(expression);
  const conditions = formatted ? formatted[2].split(',').map((part) => part.trim()) : [expression];
  const values = conditions.map((condition) => {
    if (
      condition ===
      "(needs.changes.outputs.release == 'false' || inputs.reuse_distribution) && 'runtime' || ''"
    ) {
      return scenario.outputs.release === 'false' || scenario.reuseDistribution === true
        ? 'runtime'
        : '';
    }
    const parsed =
      /^(github\.event_name|needs\.changes\.outputs\.(\w+)) (==|!=) '([^']+)' && '([^']+)' \|\| ''$/.exec(
        condition
      );
    if (!parsed) throw new Error(`unrecognized skip condition: ${condition}`);
    if (parsed[3] === '!=' && parsed[1] !== 'github.event_name') {
      throw new Error(`unrecognized skip comparison: ${condition}`);
    }
    const actual = parsed[1] === 'github.event_name' ? scenario.event : scenario.outputs[parsed[2]];
    return (actual === parsed[4]) === (parsed[3] === '==') ? parsed[5] : '';
  });
  if (!formatted) return parseAllowedSkips(values[0]);
  expect([...formatted[1].matchAll(/\{(\d+)\}/g)].map((match) => Number(match[1]))).toEqual(
    values.map((_, index) => index)
  );
  return parseAllowedSkips(formatted[1].replace(/\{(\d+)\}/g, (_, index) => values[Number(index)]));
}

for (const fixture of fixtures) {
  describe(`${fixture.name} compatibility contract`, () => {
    const workflow = readText(fixture.workflow);
    const legacy = extractJobBlock(workflow, 'gate');
    const unique = extractJobBlock(workflow, 'gate-unique');

    test('both gates directly need every mandatory lane and retain the same skip rules', () => {
      for (const producer of PRODUCERS) {
        const block = extractJobBlock(workflow, producer);
        expect(parseNeedsList(block).sort()).toEqual(expectedGateNeeds(workflow));
        expect(block).toContain(`if: ${EXPR} always() }}`);
        expect(block).toContain('permissions:\n      contents: read');
        expect(block).not.toMatch(/^ {4}continue-on-error:/m);
        const evaluation = extractStepBlocks(block).filter((step) =>
          step.includes('run: bun ./scripts/ci/evaluate-gate.ts')
        );
        expect(evaluation).toHaveLength(1);
        expect(evaluation[0]).toContain(`NEEDS: ${EXPR} toJSON(needs) }}`);
        expect(evaluation[0]).not.toContain('continue-on-error');
      }
      expect(legacy).toContain('    name: Gate\n');
      expect(unique).toContain(`    name: ${fixture.name}\n`);
      expect(skipExpression(unique)).toBe(skipExpression(legacy));
    });

    test('a missing mandatory lane is rejected by both producer contracts', () => {
      const mandatory = expectedGateNeeds(workflow);
      for (const producer of PRODUCERS) {
        const declared = parseNeedsList(extractJobBlock(workflow, producer));
        for (const missing of mandatory) {
          expect(declared.filter((job) => job !== missing).sort()).not.toEqual(mandatory);
        }
      }
      expect(() => parseNeeds('{"changes":{"outputs":{}}}')).toThrow('unrecognized result');
    });

    const scenarios: Scenario[] = fixture.cases.map((scenario) =>
      scenarioProjection(fixture.workflow, workflow, scenario)
    );
    if (fixture.workflow === '.github/workflows/ci.yml') {
      scenarios.push(
        scenarioProjection(fixture.workflow, workflow, {
          name: 'main push',
          event: 'push',
          outputs: { distribution: 'true', rust: 'true' },
          allowedSkips: [],
        })
      );
    }
    if (fixture.workflow === '.github/workflows/release-dry-run.yml') {
      for (const event of ['schedule', 'workflow_dispatch']) {
        scenarios.push(
          scenarioProjection(fixture.workflow, workflow, {
            name: `${event} clean shipping runtime`,
            event,
            outputs: { release: 'true', launcher: 'true' },
            allowedSkips: [],
          })
        );
      }
    }
    for (const scenario of scenarios) {
      test(`${scenario.name}: same verdict, only proven skips, failures and cancellations fail`, () => {
        const required = expectedGateNeeds(workflow);
        for (const producer of PRODUCERS) {
          const skips = skipsForCase(extractJobBlock(workflow, producer), scenario);
          expect([...skips].sort()).toEqual([...scenario.allowedSkips]);
          const results = Object.fromEntries(
            required.map((job) => [job, skips.has(job) ? 'skipped' : 'success'])
          ) as Record<string, NeedResult>;
          expect(evaluateGate(results, skips).ok).toBe(true);
          for (const job of required) {
            for (const result of ['failure', 'cancelled'] as const) {
              expect(evaluateGate({ ...results, [job]: result }, skips).ok).toBe(false);
            }
            if (!skips.has(job)) {
              expect(evaluateGate({ ...results, [job]: 'skipped' }, skips).ok).toBe(false);
            }
          }
          if (scenario.name === 'failed change detection') {
            expect(evaluateGate({ ...results, changes: 'failure' }, skips).ok).toBe(false);
          }
        }
      });
    }

    if (
      fixture.workflow === '.github/workflows/release-dry-run.yml' &&
      isReusableDryRun(workflow)
    ) {
      test('PR distribution reuse permits only the runtime skip and cannot hide missing lanes or failed identity', () => {
        for (const producer of PRODUCERS) {
          const block = extractJobBlock(workflow, producer);
          const scenario: Scenario = {
            name: 'relevant PR distribution reuse',
            event: 'pull_request',
            outputs: { release: 'true', launcher: 'true' },
            reuseDistribution: true,
            allowedSkips: ['runtime'],
          };
          const skips = skipsForCase(block, scenario);
          expect([...skips]).toEqual(['runtime']);
          const results = Object.fromEntries(
            expectedGateNeeds(workflow).map((job) => [job, 'success'])
          ) as Record<string, NeedResult>;
          results.runtime = 'skipped';
          expect(evaluateGate(results, skips).ok).toBe(true);
          for (const missing of ['dry-run-linux', 'dry-run-windows', 'dry-run-cargo', 'changes']) {
            expect(evaluateGate({ ...results, [missing]: 'skipped' }, skips).ok).toBe(false);
          }
          expect(evaluateGate({ ...results, changes: 'failure' }, skips).ok).toBe(false);
          expect(evaluateGate({ ...results, changes: 'cancelled' }, skips).ok).toBe(false);
          const shipping = skipsForCase(block, {
            ...scenario,
            event: 'schedule',
            reuseDistribution: false,
          });
          expect([...shipping]).toEqual([]);
          expect(evaluateGate(results, shipping).ok).toBe(false);
        }
      });
    }
  });
}

describe('compatibility checks preserve enforcement producers', () => {
  test('the four new check names are distinct and PR triggers have no path filters', () => {
    expect(new Set(fixtures.map((fixture) => fixture.name)).size).toBe(4);
    for (const fixture of fixtures) {
      const workflow = readText(fixture.workflow);
      const triggers = extractOnBlock(workflow);
      if (
        fixture.workflow === '.github/workflows/release-dry-run.yml' &&
        isReusableDryRun(workflow)
      ) {
        const ci = readText('.github/workflows/ci.yml');
        expect(extractOnBlock(ci)).toContain('pull_request:\n    branches: [main]\n  ');
        const caller = extractJobBlock(ci, 'release-dry-run');
        expect(caller).toContain(
          `if: ${EXPR} !cancelled() && github.event_name == 'pull_request' }}`
        );
        expect(parseNeedsList(caller)).toEqual(['distribution-identity', 'distribution']);
        expect(triggers).toContain('  workflow_call:');
        expect(triggers).not.toContain('  pull_request:');
      } else {
        expect(triggers).toContain('pull_request:\n    branches: [main]\n  ');
      }
      const names = extractJobBlocks(workflow).flatMap(({ block }) =>
        [...block.matchAll(/^ {4}name: (.+)$/gm)].map((match) => match[1])
      );
      expect(names.filter((name) => name === fixture.name)).toHaveLength(1);
      expect(names.filter((name) => name === 'Gate')).toHaveLength(1);
    }
    const ci = readText('.github/workflows/ci.yml');
    expect(parseNeedsList(extractJobBlock(ci, 'canary'))).toEqual([
      'gate',
      'distribution-identity',
      'distribution',
    ]);
    expect(extractJobBlock(ci, 'gate-unique')).not.toContain('actions: read');
    expect(extractJobBlock(ci, 'gate-unique')).not.toContain('report-cache-usage.ts');
  });

  test('security and label contexts keep their event visibility and permissions', () => {
    const dependency = readText('.github/workflows/dependency-review.yml');
    expect(extractOnBlock(dependency)).toContain('pull_request:\n    branches: [main]');
    expect(extractJobBlock(dependency, 'dependency-review')).toContain('name: Dependency Review');
    const codeql = readText('.github/workflows/codeql.yml');
    expect(extractOnBlock(codeql)).toContain('pull_request:\n    branches: [main]');
    expect(extractJobBlock(codeql, 'analyze')).toContain('security-events: write');
    const labeler = readText('.github/workflows/labeler.yml');
    expect(extractOnBlock(labeler)).toContain('pull_request_target:');
    const label = extractJobBlock(labeler, 'label');
    expect(label).toContain('name: Apply path-based labels');
    expect(label).toContain('pull-requests: write');
    expect(label).not.toContain('actions/checkout');
  });
});
