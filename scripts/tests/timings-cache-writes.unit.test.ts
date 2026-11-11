import { expect, test } from 'bun:test';

import { readText } from './support/read-text';
import { extractJobBlock, extractJobBlocks, extractStepBlocks } from './support/workflow-blocks';
import { cacheScopedCallSites, workflowFiles } from './support/workflow-files';

const EXPR = '$' + '{{';
const workflow = readText('.github/workflows/test.yml');

test('timing snapshots are saved only after successful trusted-main pushes', () => {
  const saves = extractStepBlocks(extractJobBlock(workflow, 'merge')).filter(
    (step) => step.includes('family: timings') && step.includes('mode: save')
  );
  expect(saves).toHaveLength(1);
  const [save] = Bun.YAML.parse(saves[0]) as Array<{ if: string }>;
  expect(save.if).toBe(
    `${EXPR} success() && needs.shard.result == 'success' && needs.frontend.result == 'success' ` +
      `&& github.event_name == 'push' && github.ref == 'refs/heads/main' }}`
  );
  expect(saves[0]).toContain(
    `validity: test-shard-${EXPR} env.SHARD_COUNT }}-${EXPR} github.run_id }}`
  );
});

test('the complete reader inventory cannot restore an old PR timing snapshot', () => {
  const callers: Array<{ path: string; job: string; step: string }> = [];
  for (const path of workflowFiles()) {
    for (const { job, block } of extractJobBlocks(readText(path))) {
      for (const step of extractStepBlocks(block)) {
        if (step.includes('family: timings')) callers.push({ path, job, step });
      }
    }
  }
  // The shared inventory also includes .yaml workflows and composite actions.
  expect(cacheScopedCallSites().filter((site) => site.inputs.family === 'timings')).toHaveLength(
    callers.length
  );
  expect(callers.map(({ path, job }) => `${path}:${job}`).sort()).toEqual(
    ['resolve-timings', 'merge'].map((job) => `.github/workflows/test.yml:${job}`).sort()
  );
  const readers = callers.filter(({ step }) => !step.includes('mode: save'));
  expect(readers.map(({ job }) => job)).toEqual(['resolve-timings']);
  const resolver = readers[0]?.step;
  expect(resolver).toContain(`validity: test-shard-${EXPR} env.SHARD_COUNT }}`);
  expect(resolver).toContain('restore-prefix: test-');
  expect(resolver).toContain('mode: restore');
  expect(resolver).not.toContain('lookup-only:');
  expect(resolver).not.toContain('rotate:');
  expect(resolver).not.toContain('github.run_id');
  // The resolver's primary lacks the saved run suffix; every fallback is main-scoped.
  const action = readText('.github/actions/cache-scoped/action.yml');
  // eslint-disable-next-line no-template-curly-in-string -- GitHub expressions and shell placeholders are literal fixture input.
  expect(action).toContain('primary_key="${prefix}-${WRITE_SCOPE}-${VALIDITY}"');
  // eslint-disable-next-line no-template-curly-in-string -- GitHub expressions and shell placeholders are literal fixture input.
  expect(action).toContain('restore_key="${prefix}-main-${VALIDITY}"');
  // eslint-disable-next-line no-template-curly-in-string -- GitHub expressions and shell placeholders are literal fixture input.
  expect(action).toContain('loose_prefix="${prefix}-main-${RESTORE_PREFIX}"');
});
