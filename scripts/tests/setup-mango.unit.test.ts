import { describe, expect, test } from 'bun:test';

import { readText } from './support/read-text';
import { extractStepBlocksAtIndent } from './support/workflow-blocks';
import { cacheScopedCallSites } from './support/workflow-files';

describe('setup-mango Bun cache lifecycle', () => {
  test('saves the populated Bun cache inline only after a successful main push miss', () => {
    const manifest = readText('.github/actions/setup-mango/action.yml');
    const steps = extractStepBlocksAtIndent(manifest, 4);
    const bun = cacheScopedCallSites().filter((site) => site.inputs.family === 'bun');
    expect(bun.map((site) => site.inputs.mode)).toEqual(['restore', 'save']);
    const [restore, save] = bun;
    for (const input of ['family', 'path', 'validity', 'cache-epoch']) {
      expect(save.inputs[input], input).toBe(restore.inputs[input]);
    }
    expect(restore.id).toBe('cache');
    expect(save.block).toContain("success() && github.event_name == 'push'");
    expect(save.block).toContain("github.ref == 'refs/heads/main'");
    expect(save.block).toContain("steps.cache.outputs.cache-hit != 'true'");
    const install = steps.findIndex((step) => step.includes('bun install --frozen-lockfile'));
    expect(install).toBeGreaterThan(steps.indexOf(restore.block));
    expect(install).toBeLessThan(steps.indexOf(save.block));
    expect(steps[install]).not.toMatch(/\n\s+if:/);
    expect(restore.inputs['fail-on-cache-miss']).toBeUndefined();
  });
});
