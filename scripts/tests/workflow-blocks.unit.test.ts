import { describe, expect, test } from 'bun:test';

import { parseNeedsList, runScriptLines } from './support/workflow-blocks';
import { parseWithInputs, uploadPaths } from './support/workflow-files';

// Regression test for a real outage: a `needs: [a, b]` flow sequence wrapped
// onto its own line as `needs:\n  [\n    a,\n    b,\n  ]` (the shape a hand
// edit produced here, and the shape the YAML formatter is free to
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

  test('reads the YAML formatter’s wrapped form, "needs: [" then items each on their own line', () => {
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

describe('workflow scalar projections', () => {
  test('run lines retain comments, indentation, source positions and inline continuations', () => {
    const source = [
      'defaults:',
      '  # Keep defaults.run a mapping.',
      '  run:',
      '    shell: bash',
      'steps:',
      '  - run: >-',
      '      # Script comments are script text.',
      '      echo first',
      '',
      '      echo last',
      '    env:',
      '      OUTSIDE: ignored',
      '  - run: echo inline',
      '      continuation',
      '    shell: bash',
    ].join('\n');
    expect(runScriptLines(source)).toEqual([
      { line: 7, text: '      # Script comments are script text.' },
      { line: 8, text: '      echo first' },
      { line: 10, text: '      echo last' },
      { line: 13, text: '  - run: echo inline' },
      { line: 14, text: '      continuation' },
    ]);
  });

  test('upload paths ignore comments without absorbing the next sibling key', () => {
    const step = [
      '  with:',
      '    path: |-',
      '      dist/app.tar.gz',
      '',
      '      # YAML comment ignored by path policy.',
      '# A dedented comment does not end the paths.',
      '      dist/checksums.txt',
      '    name: archive',
      '    path: dist/inline.zip',
    ].join('\n');
    expect(uploadPaths(step)).toEqual(['dist/app.tar.gz', 'dist/checksums.txt', 'dist/inline.zip']);
    expect(uploadPaths('    path: >\n      one\n      two\n    name: stop')).toEqual([
      'one',
      'two',
    ]);
    expect(uploadPaths('    path:\n      one\n    name: stop')).toEqual(['one']);
  });

  test('with-inputs keep flat values and omit empty, literal and folded scalars', () => {
    const step = [
      '  - uses: ./.github/actions/cache-scoped',
      '    with:',
      "      family: 'bun'",
      '      empty:',
      '      multiline: |',
      '        line one',
      '        line two',
      '      folded: >-',
      '        more content',
      '      # Comments are not inputs.',
      '      mode: "restore"',
      '      key: build-cache',
      '    env:',
      '      OUTSIDE: ignored',
    ].join('\n');
    expect(parseWithInputs(step)).toEqual({ family: 'bun', mode: 'restore', key: 'build-cache' });
    expect(parseWithInputs('  - run: echo no inputs')).toEqual({});
  });

  test('flat with-input projection preserves its existing line-oriented interpretation', () => {
    // This convenience reader is not the structural github-script policy.
    // Preserve its existing output rather than changing policy in this refactor.
    expect(
      parseWithInputs('    with:\n      script: |\n        nested: legacy\n      family: bun')
    ).toEqual({ nested: 'legacy', family: 'bun' });
  });
});
