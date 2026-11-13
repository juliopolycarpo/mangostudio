import { expect, test } from 'bun:test';

import { readText } from './support/read-text';
import { extractJobBlock } from './support/workflow-blocks';

test.each(['ci', 'cargo-shim', 'protocol-ci', 'release-dry-run'])(
  '%s retains only its unique aggregate',
  (name) => {
    const source = readText(`.github/workflows/${name}.yml`);
    expect(
      extractJobBlock(source, 'gate'),
      'legacy bare Gate must be retired after ruleset migration'
    ).toBe('');
    expect(extractJobBlock(source, 'gate-unique')).toContain(
      'run: bun ./scripts/ci/evaluate-gate.ts'
    );
  }
);
test('light cache seed waits for the surviving CI verdict', () => {
  const seed = extractJobBlock(readText('.github/workflows/ci.yml'), 'runtime-cache-seed');
  expect(seed).toContain('needs: [gate-unique, changes]');
  expect(seed).toContain("needs['gate-unique'].result == 'success'");
});
