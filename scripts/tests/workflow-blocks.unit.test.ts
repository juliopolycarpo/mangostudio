import { describe, expect, test } from 'bun:test';

import { parseNeedsList } from './support/workflow-blocks';

// Regression test for a real outage: a `needs: [a, b]` flow sequence wrapped
// onto its own line as `needs:\n  [\n    a,\n    b,\n  ]` (the shape a hand
// edit produced here, and the shape dprint's own YAML plugin is free to
// choose once a list passes the repo's 100-column lineWidth) broke
// parseNeedsList's old regex, which required the literal text "needs: ["
// with nothing but a single space in between. The old regex silently
// returned [] for that shape, which ci-gate.unit.test.ts read as "gate needs
// nothing" rather than failing loudly on a parse error.
describe('parseNeedsList', () => {
  test('reads a single-line flow sequence', () => {
    const block = '  gate:\n    needs: [a, b, c]\n    if: always()\n';
    expect(parseNeedsList(block)).toEqual(['a', 'b', 'c']);
  });

  test('reads dprint’s own wrapped form, "needs: [" then items each on their own line', () => {
    const block = '  gate:\n    needs: [\n      a,\n      b,\n      c,\n    ]\n    if: always()\n';
    expect(parseNeedsList(block)).toEqual(['a', 'b', 'c']);
  });

  test('reads a hand-wrapped form with the opening bracket on its own line', () => {
    const block =
      '  gate:\n    needs:\n      [\n        a,\n        b,\n        c,\n      ]\n    if: always()\n';
    expect(parseNeedsList(block)).toEqual(['a', 'b', 'c']);
  });

  test('returns [] when the job has no needs key at all', () => {
    const block = '  changes:\n    runs-on: ubuntu-latest\n';
    expect(parseNeedsList(block)).toEqual([]);
  });
});
