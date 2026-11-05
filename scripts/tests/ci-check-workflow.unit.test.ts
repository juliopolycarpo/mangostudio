import { expect, test } from 'bun:test';

import { readText } from './support/read-text';
import { extractJobBlock, extractStepBlocks } from './support/workflow-blocks';

test('canonical Check binds its invocation to QA and uploads failure evidence', () => {
  const ci = readText('.github/workflows/ci.yml');
  const qa = extractJobBlock(ci, 'qa-metrics');
  expect(qa, 'QA must wait for canonical Check rather than rerun validation').toMatch(
    /needs: \[[^\]]*check[^\]]*\]/
  );
  expect(qa).toContain('needs.check.outputs.invocation_id');
  expect(qa).toContain('needs.check.outputs.producer_attempt');
  const consumer = extractJobBlock(readText('.github/workflows/qa-metrics.yml'), 'collect');
  expect(consumer).toContain('name: qa-check-evidence-' + '$' + '{{ inputs.check_invocation_id }}');
  expect(consumer).toContain(
    'QA_CHECK_PRODUCER_ATTEMPT: ' + '$' + '{{ inputs.check_producer_attempt }}'
  );
  const producer = extractJobBlock(readText('.github/workflows/lint.yml'), 'check');
  const steps = extractStepBlocks(producer);
  const run = steps.find((step) => step.includes('name: Run check'));
  expect(run).toContain(
    'bun run check --all --ci-report --report-file check-evidence.json --report-id'
  );
  const upload = steps.find((step) => step.includes('name: Upload canonical Check evidence'));
  expect(upload).toContain('if: $' + '{{ !cancelled() }}');
  expect(upload).toContain(
    'name: qa-check-evidence-' + '$' + '{{ steps.identity.outputs.invocation_id }}'
  );
  expect(upload).toContain('overwrite: false');
});

test('canonical diagnostics replace only workspace TypeScript compilation', async () => {
  const { createTurboCheckCommand } = await import('../lib/check');
  const { protocolCheckTasks } = await import('../protocol/tasks');
  expect(createTurboCheckCommand(['api'], false)).toEqual(
    createTurboCheckCommand(['api']).filter((argument) => argument !== 'typecheck:with-deps')
  );
  const ordinary = protocolCheckTasks(['--ts-only'], { cargo: false, cargoHack: false });
  const reported = protocolCheckTasks(
    ['--ts-only'],
    { cargo: false, cargoHack: false },
    undefined,
    { typecheck: false }
  );
  expect(reported).toEqual(
    ordinary.map((task) => ({
      ...task,
      cmd: task.cmd.filter((argument) => argument !== 'typecheck:with-deps'),
    }))
  );
});
