import { expect, test } from 'bun:test';

import { readText } from './support/read-text';

interface Step {
  id?: string;
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
}
interface Job {
  name?: string;
  needs?: string[];
  permissions?: Record<string, string>;
  steps?: Step[];
}
interface Workflow {
  concurrency: { 'cancel-in-progress': boolean };
  jobs: Record<string, Job>;
}
const workflow = (): Workflow =>
  Bun.YAML.parse(readText('.github/workflows/canary.yml')) as Workflow;

test('canary promotes approved CI bytes without cancelling a partially published version', () => {
  const value = workflow();
  expect(value.concurrency['cancel-in-progress']).toBe(false);
  expect(value.jobs.build).toBeUndefined();
  expect(value.jobs.approve).toBeDefined();
  expect(readText('.github/workflows/canary.yml')).not.toContain(
    'uses: $/.github/workflows/distribution-build.yml'
  );
});

test('every publishing job rechecks registry state after acquiring its approval and before writes', () => {
  for (const name of ['npm-canary', 'github-release-canary']) {
    const job = workflow().jobs[name];
    expect(job.needs, name).toEqual(['source', 'approve']);
    expect(job.permissions?.actions, name).toBe('read');
    expect(job.permissions?.contents, name).toBe('write');
    const steps = job.steps ?? [];
    const load = steps.findIndex((step) => step.id === 'approved');
    const guard = steps.findIndex((step) => step.id === 'guard');
    const write = steps.findIndex((step) => step.id === 'publish');
    expect(load, name).toBeGreaterThan(-1);
    expect(guard, name).toBeGreaterThan(load);
    expect(write, name).toBeGreaterThan(guard);
    expect(steps[load].env?.EXPECTED_APPROVAL_SHA256, name).toBe(
      `${'$'}{{ needs.approve.outputs.approval_sha256 }}`
    );
    expect(steps[guard].run, name).toContain('audit-canary-publication.ts');
    expect(steps[guard].env?.APPROVAL_ORIGIN, name).toBe(
      `${'$'}{{ steps.approved.outputs.approval_origin }}`
    );
    expect(steps[write].if, name).toContain('steps.guard.outputs.');
  }
});

test('a successful approval always reserves its original archive after attestation', () => {
  const job = workflow().jobs.approve;
  expect(job?.name).toBe(
    `Approve canary ${'$'}{{ needs.source.outputs.version }} from ${'$'}{{ needs.source.outputs.source_sha }}`
  );
  const steps = job.steps ?? [];
  const attest = steps.findIndex((step) =>
    step.uses?.startsWith('actions/attest-build-provenance@')
  );
  const upload = steps.findIndex((step) => step.id === 'reservation');
  expect(attest).toBeGreaterThan(-1);
  expect(upload).toBe(steps.length - 1);
  expect(upload).toBeGreaterThan(attest);
  expect(steps[upload].if).toBeUndefined();
  expect(steps[upload].with?.overwrite).toBe(false);
  expect(steps[upload].with?.['retention-days']).toBe(30);
});

test('source snapshots are written from trusted execution code after reading selected app identity', () => {
  const steps = workflow().jobs.source.steps ?? [];
  const identity = steps.findIndex((step) => step.id === 'identity');
  const write = steps.findIndex((step) => step.id === 'snapshot');
  const trusted = steps.reduce(
    (last, step, index) =>
      step.uses?.startsWith('actions/checkout@') && step.with?.ref === `${'$'}{{ github.sha }}`
        ? index
        : last,
    -1
  );
  expect(identity).toBeGreaterThan(-1);
  expect(trusted).toBeGreaterThan(identity);
  expect(write).toBeGreaterThan(trusted);
  expect(steps[identity].run).toContain('git rev-parse HEAD');
  expect(steps[write].run).toContain('freeze-canary-source.ts write');
  expect(steps.at(-1)?.uses).toContain('actions/upload-artifact@');
});

test('manual recovery carries all three explicit inputs into source validation and pins approval acquisition', () => {
  const parsed = Bun.YAML.parse(readText('.github/workflows/canary.yml')) as {
    on: { workflow_dispatch: { inputs: Record<string, { type: string; required: boolean }> } };
    jobs: Record<string, Job & { outputs: Record<string, string> }>;
  };
  expect(Object.keys(parsed.on.workflow_dispatch.inputs)).toEqual([
    'recover_source_run_id',
    'recover_source_attempt',
    'recover_approval_sha256',
  ]);
  for (const input of Object.values(parsed.on.workflow_dispatch.inputs)) {
    expect(input.type).toBe('string');
    expect(input.required).toBe(false);
  }
  const source = parsed.jobs.source;
  const resolve = source.steps?.find((step) => step.id === 'source');
  expect(resolve?.env?.RECOVER_SOURCE_RUN_ID).toBe(`${'$'}{{ inputs.recover_source_run_id }}`);
  expect(resolve?.env?.RECOVER_SOURCE_ATTEMPT).toBe(`${'$'}{{ inputs.recover_source_attempt }}`);
  expect(resolve?.env?.RECOVER_APPROVAL_SHA256).toBe(`${'$'}{{ inputs.recover_approval_sha256 }}`);
  expect(source.outputs.expected_approval_sha256).toBe(
    `${'$'}{{ steps.source.outputs.expected_approval_sha256 }}`
  );
  expect(
    parsed.jobs.approve.steps?.find((step) => step.id === 'approved')?.env?.EXPECTED_APPROVAL_SHA256
  ).toBe(`${'$'}{{ needs.source.outputs.expected_approval_sha256 }}`);
});
