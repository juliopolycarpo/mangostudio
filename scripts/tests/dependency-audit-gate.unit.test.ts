import { describe, expect, test } from 'bun:test';
import { readText } from './support/read-text';
import {
  extractJobBlock,
  extractJobBlocks,
  extractOnBlock,
  extractStepBlocks,
  parseNeedsList,
} from './support/workflow-blocks';

interface Job {
  if?: string;
  'continue-on-error'?: boolean;
  steps?: Array<{ name?: string; run?: string; if?: string; 'continue-on-error'?: boolean }>;
}

interface Workflow {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  jobs: Record<string, Job>;
}

const ci = readText('.github/workflows/ci.yml');
const audit = Bun.YAML.parse(readText('.github/workflows/dependency-audit.yml')) as Workflow;

describe('mandatory dependency audit', () => {
  test('CI calls the audit once without path, result, or fork conditions', () => {
    const callers = extractJobBlocks(ci).filter(({ block }) =>
      block.includes('uses: ./.github/workflows/dependency-audit.yml')
    );
    expect(callers.map(({ job }) => job)).toEqual(['dependency-audit']);
    expect(callers[0].block).not.toMatch(/^ {4}(if|needs|continue-on-error):/m);
    const on = extractOnBlock(ci);
    expect(on).toContain('pull_request:\n    branches: [main]');
    expect(on).not.toMatch(/paths|pull_request_target/);
  });

  test('reuses the moderate policy, preserves schedule and removes duplicate PR trigger', () => {
    expect(audit.on).toEqual({
      workflow_call: null,
      schedule: [{ cron: '23 6 * * *' }],
      workflow_dispatch: null,
    });
    expect(audit.permissions).toEqual({ contents: 'read' });
    expect(Object.keys(audit.jobs)).toEqual(['audit']);
    const job = audit.jobs.audit;
    expect(job.if).toBeUndefined();
    expect(job['continue-on-error']).toBeUndefined();
    const commands = job.steps?.filter((step) => step.run);
    expect(commands).toEqual([{ name: 'Audit bun.lock', run: 'bun audit --audit-level=moderate' }]);
    expect(readText('.github/workflows/dependency-audit.yml')).toContain(
      'persist-credentials: false'
    );
  });

  for (const gate of ['gate', 'gate-unique']) {
    test(`${gate} rejects failed, cancelled and skipped audits through the real evaluator`, () => {
      const job = extractJobBlock(ci, gate);
      const dependencies = parseNeedsList(job);
      expect(dependencies).toContain('dependency-audit');
      expect(job).toContain('if: $' + '{{ always() }}');
      expect(job).not.toMatch(/^ {4}continue-on-error:/m);
      const verdict = extractStepBlocks(job).find((step) =>
        step.includes('run: bun ./scripts/ci/evaluate-gate.ts')
      );
      expect(verdict).toBeDefined();
      expect(verdict).not.toMatch(/^ {8}(if|continue-on-error):/m);
      const skipPolicy = job.split('ALLOWED_SKIPS:')[1]?.split('run:')[0];
      expect(skipPolicy).toBeDefined();
      expect(skipPolicy).not.toContain('dependency-audit');
      // Use each gate's actual needs, with every other producer succeeding.
      // No audit failure may be hidden by the successful siblings.
      for (const result of ['success', 'failure', 'cancelled', 'skipped']) {
        const needs = Object.fromEntries(
          dependencies.map((id) => [id, { result: id === 'dependency-audit' ? result : 'success' }])
        );
        const child = Bun.spawnSync([process.execPath, './scripts/ci/evaluate-gate.ts'], {
          env: { ...process.env, NEEDS: JSON.stringify(needs), ALLOWED_SKIPS: '' },
        });
        expect(child.exitCode, `${gate}: audit ${result}`).toBe(result === 'success' ? 0 : 1);
        expect(child.stdout.toString()).toContain(`dependency-audit: ${result}`);
      }
    });
  }
});
