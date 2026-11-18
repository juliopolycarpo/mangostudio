import { describe, expect, test } from 'bun:test';

import {
  extractStepBlock,
  extractStepBlocksUsing,
  extractTopLevelBlock,
  parseNeedsList,
  runScriptLines,
} from './support/workflow-blocks';
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

describe('extractTopLevelBlock', () => {
  const workflow = [
    'name: Demo',
    'concurrency:',
    '  group: demo',
    '  cancel-in-progress: false',
    'permissions: {}',
    'jobs:',
    '  build:',
    '    concurrency:',
    '      group: job-level',
  ].join('\n');

  test('reads the top-level mapping and never a job-level one with the same key', () => {
    const block = extractTopLevelBlock(workflow, 'concurrency');
    expect(block).toContain('cancel-in-progress: false');
    expect(block).not.toContain('job-level');
  });

  test('returns an empty block for an inline value or an absent key', () => {
    expect(extractTopLevelBlock(workflow, 'permissions')).toBe('');
    expect(extractTopLevelBlock(workflow, 'env')).toBe('');
  });
});

describe('extractStepBlock', () => {
  const job = [
    '    steps:',
    '      - name: Build',
    '        run: make',
    '      - uses: actions/upload-artifact@v4',
    '        with:',
    '          name: Build',
    '          path: out',
    '      - uses: actions/checkout@v4',
    '        name: Check out # why',
    '        with:',
    '          persist-credentials: false',
  ].join('\n');

  test('returns only the named step, whichever key order it was written in', () => {
    expect(extractStepBlock(job, 'Build')).toBe('      - name: Build\n        run: make\n');
    expect(extractStepBlock(job, 'Check out')).toContain('persist-credentials: false');
    expect(extractStepBlock(job, 'Check out')).not.toContain('run: make');
  });

  test('ignores a nested `name:` input that happens to equal the step name', () => {
    // The upload step's `with: name: Build` must not make "Build" ambiguous.
    expect(extractStepBlock(job, 'Build')).not.toContain('upload-artifact');
  });

  test('reads composite-action steps at indent 4', () => {
    const action = ['runs:', '  steps:', '    - name: Verify', '      run: true'].join('\n');
    expect(extractStepBlock(action, 'Verify', 4)).toContain('run: true');
  });

  test('throws naming the missing step and the steps it did find', () => {
    expect(() => extractStepBlock(job, 'Deploy')).toThrow(
      'expected exactly one step named "Deploy" | received: 0 of [Build, <unnamed>, Check out]'
    );
  });

  test('throws when two steps share the name instead of picking one', () => {
    const duplicated = `${job}\n      - name: Build\n        run: other`;
    expect(() => extractStepBlock(duplicated, 'Build')).toThrow('received: 2 of');
  });
});

describe('extractStepBlocksUsing', () => {
  const job = [
    '    steps:',
    '      - uses: github/codeql-action/init@abc # v4',
    '        with:',
    '          languages: rust',
    '      - uses: github/codeql-action/analyze@abc # v4',
    '        with:',
    '          category: rust',
    '      - name: Check',
    '        uses: ./.github/actions/local',
    '      - run: echo "uses: github/codeql-action/init@abc"',
  ].join('\n');

  test('matches the action exactly, not a longer action path sharing its prefix', () => {
    const [init, ...rest] = extractStepBlocksUsing(job, 'github/codeql-action/init');
    expect(rest).toEqual([]);
    expect(init).toContain('languages: rust');
    expect(init).not.toContain('category: rust');
  });

  test('finds uses written after the step name, and local actions without a ref', () => {
    expect(extractStepBlocksUsing(job, './.github/actions/local')).toHaveLength(1);
  });

  test('does not read the text of a run script as a uses line', () => {
    expect(extractStepBlocksUsing(job, 'github/codeql-action/init')).toHaveLength(1);
  });

  test('returns an empty list for an absent action', () => {
    expect(extractStepBlocksUsing(job, 'actions/checkout')).toEqual([]);
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

  test('run opener keeps the line boundary at an embedded line separator', () => {
    const source = 'run:\u2028echo unsupported\n  following text\nrun: echo valid';
    expect(runScriptLines(source)).toEqual([{ line: 3, text: 'run: echo valid' }]);
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

  test('upload paths revisit matching lines inside the preceding path block', () => {
    const step = '    path: |\n      path: nested.zip\n      last.txt\n    name: stop';
    expect(uploadPaths(step)).toEqual(['path: nested.zip', 'last.txt', 'nested.zip']);
  });

  test('upload paths leave a pipe after non-ASCII whitespace inline', () => {
    expect(uploadPaths('    path:\u00a0|\n      content.txt\n    name: stop')).toEqual(['|']);
  });

  test('flat inputs omit a value containing only non-ASCII whitespace', () => {
    expect(parseWithInputs('    with:\n      empty:\u00a0\n      mode: restore')).toEqual({
      mode: 'restore',
    });
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
