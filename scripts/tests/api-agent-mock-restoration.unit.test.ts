import { expect, test } from 'bun:test';
import { resolve } from 'node:path';

const repoRoot = resolve(import.meta.dir, '../..');

test('agent mocks can be replaced after the full app has loaded in the same process', () => {
  const result = Bun.spawnSync(
    [
      process.execPath,
      '../../scripts/with-test-home.ts',
      process.execPath,
      'test',
      '--timeout',
      '15000',
      'tests/integration/routes/app-plugin-contract.integration.test.ts',
      'tests/integration/routes/respond-stream-agents.integration.test.ts',
    ],
    { cwd: resolve(repoRoot, 'apps/api'), stdout: 'pipe', stderr: 'pipe' }
  );
  const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
  expect(result.exitCode, output).toBe(0);
  expect(output).toContain('returns 404 for an unknown agent before SSE starts');
  expect(output).not.toContain('(fail)');
}, 15000);
