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

function skipExpression(block: string): string {
  const expression = /ALLOWED_SKIPS: \$\{\{\s*([\s\S]*?)\s*\}\}/.exec(block)?.[1];
  if (!expression) throw new Error('gate must declare ALLOWED_SKIPS');
  return expression;
}

// Evaluate only the literal comparison/format grammar used by these gates.
// Unknown syntax fails the test, so adding a skip rule requires a new fixture.
function skipsForCase(
  block: string,
  scenario: { event: string; outputs: Readonly<Record<string, string | undefined>> }
): Set<string> {
  const expression = skipExpression(block);
  const formatted = /^format\('([^']*)',\s*([\s\S]*)\)$/.exec(expression);
  const conditions = formatted ? formatted[2].split(',').map((part) => part.trim()) : [expression];
  const values = conditions.map((condition) => {
    const parsed =
      /^(github\.event_name|needs\.changes\.outputs\.(\w+)) == '([^']+)' && '([^']+)' \|\| ''$/.exec(
        condition
      );
    if (!parsed) throw new Error(`unrecognized skip condition: ${condition}`);
    const actual = parsed[1] === 'github.event_name' ? scenario.event : scenario.outputs[parsed[2]];
    return actual === parsed[3] ? parsed[4] : '';
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

    for (const scenario of fixture.cases) {
      test(`${scenario.name}: same verdict, only proven skips, failures and cancellations fail`, () => {
        const required = expectedGateNeeds(workflow);
        for (const producer of PRODUCERS) {
          const skips = skipsForCase(extractJobBlock(workflow, producer), scenario);
          expect([...skips].sort()).toEqual(scenario.allowedSkips);
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
  });
}

describe('compatibility checks preserve enforcement producers', () => {
  test('the four new check names are distinct and PR triggers have no path filters', () => {
    expect(new Set(fixtures.map((fixture) => fixture.name)).size).toBe(4);
    for (const fixture of fixtures) {
      const workflow = readText(fixture.workflow);
      const triggers = extractOnBlock(workflow);
      expect(triggers).toContain('pull_request:\n    branches: [main]\n  ');
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
