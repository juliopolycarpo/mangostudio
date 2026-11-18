import { describe, expect, it } from 'bun:test';

import {
  addIntraLineEmphasis,
  buildFileChangePreview,
  DIFF_PREVIEW_MAX_LINES,
  type DiffPreviewLine,
  diffTextLines,
  findLatestFileChangeId,
  INTRA_LINE_MAX_LINE_LENGTH,
  INTRA_LINE_MAX_PAIRS,
  truncateDiffLines,
} from '../../src/features/chat/components/file-change-preview';

describe('buildFileChangePreview', () => {
  it('returns null for non-previewable tools', () => {
    expect(buildFileChangePreview('read_file', { path: '/a.txt' })).toBeNull();
    expect(buildFileChangePreview('bash', { command: 'ls' })).toBeNull();
  });

  it('returns null while required arguments are still streaming in', () => {
    expect(buildFileChangePreview('edit_file', { path: '/a.txt' })).toBeNull();
    expect(buildFileChangePreview('create_file', {})).toBeNull();
    expect(buildFileChangePreview('move_file', { from: '/a.txt' })).toBeNull();
  });

  it('renders create_file content as pure additions', () => {
    const preview = buildFileChangePreview('create_file', {
      path: '/notes.md',
      content: 'one\ntwo\n',
    });
    expect(preview).toEqual({
      files: [
        {
          op: 'create',
          path: '/notes.md',
          lines: [
            { kind: 'add', text: 'one' },
            { kind: 'add', text: 'two' },
          ],
          added: 2,
          removed: 0,
        },
      ],
    });
  });

  it('marks write_file as overwrite only when the result says created=false', () => {
    const args = { path: '/a.txt', content: 'x' };
    expect(buildFileChangePreview('write_file', args)?.files[0]?.op).toBe('create');
    expect(
      buildFileChangePreview('write_file', args, JSON.stringify({ created: false }))?.files[0]?.op
    ).toBe('overwrite');
    expect(
      buildFileChangePreview('write_file', args, JSON.stringify({ created: true }))?.files[0]?.op
    ).toBe('create');
  });

  it('renders write_file overwrite with a line diff when before is on the result', () => {
    const preview = buildFileChangePreview(
      'write_file',
      { path: '/a.txt', content: 'new\n' },
      JSON.stringify({ created: false, before: 'old\n' })
    );
    expect(preview?.files[0]?.removed).toBeGreaterThan(0);
    expect(preview?.files[0]?.added).toBeGreaterThan(0);
  });

  it('diffs edit_file oldString/newString line by line with context', () => {
    const preview = buildFileChangePreview('edit_file', {
      path: '/src/app.ts',
      oldString: 'const a = 1;\nconst b = 2;\nconst c = 3;',
      newString: 'const a = 1;\nconst b = 20;\nconst c = 3;',
    });
    expect(preview?.files[0]?.lines).toEqual([
      { kind: 'context', text: 'const a = 1;' },
      { kind: 'del', text: 'const b = 2;' },
      // A pure insertion inside the line: only the added side has a span.
      { kind: 'add', text: 'const b = 20;', emphasis: { start: 11, end: 12 } },
      { kind: 'context', text: 'const c = 3;' },
    ]);
    expect(preview?.files[0]?.added).toBe(1);
    expect(preview?.files[0]?.removed).toBe(1);
    expect(preview?.repeatCount).toBeUndefined();
  });

  it('collapses unchanged runs far from a change into a hunk marker', () => {
    const before = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
    const after = [...before];
    after[29] = 'changed';

    const preview = buildFileChangePreview(
      'write_file',
      { path: '/big.txt', content: `${after.join('\n')}\n` },
      JSON.stringify({ created: false, before: `${before.join('\n')}\n` })
    );

    const lines = preview?.files[0]?.lines ?? [];
    // 3 lines of context on each side, the change pair, and one gap marker.
    expect(lines).toEqual([
      { kind: 'marker', text: '@@ -27,7 +27,7 @@' },
      { kind: 'context', text: 'line 27' },
      { kind: 'context', text: 'line 28' },
      { kind: 'context', text: 'line 29' },
      { kind: 'del', text: 'line 30' },
      { kind: 'add', text: 'changed' },
      { kind: 'context', text: 'line 31' },
      { kind: 'context', text: 'line 32' },
      { kind: 'context', text: 'line 33' },
    ]);
    expect(preview?.files[0]?.added).toBe(1);
    expect(preview?.files[0]?.removed).toBe(1);
  });

  it('keeps a leading change headerless and marks only later gaps', () => {
    const before = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
    const after = [...before];
    after[0] = 'first changed';
    after[39] = 'last changed';

    const preview = buildFileChangePreview(
      'write_file',
      { path: '/big.txt', content: `${after.join('\n')}\n` },
      JSON.stringify({ created: false, before: `${before.join('\n')}\n` })
    );

    const lines = preview?.files[0]?.lines ?? [];
    expect(lines[0]).toEqual({ kind: 'del', text: 'line 1' });
    expect(lines.filter((line) => line.kind === 'marker')).toEqual([
      { kind: 'marker', text: '@@ -37,4 +37,4 @@' },
    ]);
    expect(lines.map((line) => line.text)).not.toContain('line 20');
  });

  it('renders an unchanged rewrite as an empty diff body', () => {
    const preview = buildFileChangePreview(
      'write_file',
      { path: '/same.txt', content: 'a\nb\n' },
      JSON.stringify({ created: false, before: 'a\nb\n' })
    );
    expect(preview?.files[0]).toMatchObject({ lines: [], added: 0, removed: 0 });
  });

  it('reports the replaceAll repeat count from the edit_file result', () => {
    const preview = buildFileChangePreview(
      'edit_file',
      { path: '/a.txt', oldString: 'x', newString: 'y', replaceAll: true },
      JSON.stringify({ replacements: 3 })
    );
    expect(preview?.repeatCount).toBe(3);
  });

  it('summarizes replace_range with a range marker and additions', () => {
    const preview = buildFileChangePreview('replace_range', {
      path: '/a.txt',
      startLine: 3,
      endLine: 5,
      content: 'new line\n',
    });
    expect(preview?.files[0]?.lines).toEqual([
      { kind: 'marker', text: '@@ -3,3 @@' },
      { kind: 'add', text: 'new line' },
    ]);
    expect(preview?.files[0]?.removed).toBe(3);
    expect(preview?.files[0]?.added).toBe(1);
  });

  it('rejects an inverted replace_range', () => {
    expect(
      buildFileChangePreview('replace_range', {
        path: '/a.txt',
        startLine: 5,
        endLine: 3,
        content: '',
      })
    ).toBeNull();
  });

  it('rejects replace_range line numbers outside the tool contract', () => {
    const base = { path: '/a.txt', content: '' };
    expect(
      buildFileChangePreview('replace_range', { ...base, startLine: 0, endLine: 3 })
    ).toBeNull();
    expect(
      buildFileChangePreview('replace_range', { ...base, startLine: -2, endLine: 3 })
    ).toBeNull();
    expect(
      buildFileChangePreview('replace_range', { ...base, startLine: 1.5, endLine: 3 })
    ).toBeNull();
  });

  it('renders delete_file and move_file as path banners', () => {
    expect(buildFileChangePreview('delete_file', { path: '/gone.txt' })?.files[0]).toMatchObject({
      op: 'delete',
      path: '/gone.txt',
    });
    expect(
      buildFileChangePreview('move_file', { from: '/a.txt', to: '/b.txt' })?.files[0]
    ).toMatchObject({ op: 'move', path: '/a.txt', movedTo: '/b.txt' });
  });

  it('splits an apply_patch document into per-file sections', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: src/app.ts',
      '*** Move to: src/main.ts',
      '@@ function main',
      ' context line',
      '-old line',
      '+new line',
      '*** Add File: docs/new.md',
      '+# Title',
      '+Body',
      '*** Delete File: legacy.txt',
      '*** End Patch',
    ].join('\n');

    const preview = buildFileChangePreview('apply_patch', { patch });
    expect(preview?.files).toHaveLength(3);
    expect(preview?.files[0]).toEqual({
      op: 'update',
      path: 'src/app.ts',
      movedTo: 'src/main.ts',
      lines: [
        { kind: 'marker', text: '@@ function main' },
        { kind: 'context', text: 'context line' },
        { kind: 'del', text: 'old line', emphasis: { start: 0, end: 3 } },
        { kind: 'add', text: 'new line', emphasis: { start: 0, end: 3 } },
      ],
      added: 1,
      removed: 1,
    });
    expect(preview?.files[1]).toMatchObject({
      op: 'create',
      path: 'docs/new.md',
      added: 2,
      lines: [
        { kind: 'add', text: '# Title' },
        { kind: 'add', text: 'Body' },
      ],
    });
    expect(preview?.files[2]).toMatchObject({ op: 'delete', path: 'legacy.txt', lines: [] });
  });

  it('tolerates a partially streamed patch without throwing', () => {
    expect(buildFileChangePreview('apply_patch', { patch: '*** Begin Patch\n*** Upd' })).toBeNull();
    const partial = buildFileChangePreview('apply_patch', {
      patch: '*** Begin Patch\n*** Update File: a.ts\n+half',
    });
    expect(partial?.files[0]).toMatchObject({ op: 'update', path: 'a.ts', added: 1 });
  });

  it('handles CRLF content', () => {
    const preview = buildFileChangePreview('create_file', {
      path: '/a.txt',
      content: 'one\r\ntwo\r\n',
    });
    expect(preview?.files[0]?.lines).toEqual([
      { kind: 'add', text: 'one' },
      { kind: 'add', text: 'two' },
    ]);
  });
});

describe('truncateDiffLines', () => {
  it('passes small diffs through untouched', () => {
    const lines = [{ kind: 'add' as const, text: 'x' }];
    expect(truncateDiffLines(lines)).toEqual({ lines, hiddenCount: 0 });
  });

  it('caps oversized diffs and reports the hidden remainder', () => {
    const lines = Array.from({ length: DIFF_PREVIEW_MAX_LINES + 25 }, (_, i) => ({
      kind: 'add' as const,
      text: `line ${i}`,
    }));
    const { lines: kept, hiddenCount } = truncateDiffLines(lines);
    expect(kept).toHaveLength(DIFF_PREVIEW_MAX_LINES);
    expect(hiddenCount).toBe(25);
  });
});

describe('findLatestFileChangeId', () => {
  it('returns the last mutation call, skipping reads and other parts', () => {
    expect(
      findLatestFileChangeId([
        { type: 'tool_call', name: 'edit_file', toolCallId: 'first' },
        { type: 'tool_call', name: 'write_file', toolCallId: 'second' },
        { type: 'tool_call', name: 'read_file', toolCallId: 'read' },
        { type: 'text' },
      ])
    ).toBe('second');
  });

  it('returns null when no mutation call exists', () => {
    expect(
      findLatestFileChangeId([{ type: 'tool_call', name: 'grep', toolCallId: 'g' }])
    ).toBeNull();
  });
});

function del(text: string): DiffPreviewLine {
  return { kind: 'del', text };
}

function add(text: string): DiffPreviewLine {
  return { kind: 'add', text };
}

function context(text: string): DiffPreviewLine {
  return { kind: 'context', text };
}

describe('addIntraLineEmphasis', () => {
  it('marks the changed identifier between a shared prefix and suffix', () => {
    const deleted = 'const total = computeTotal(items);';
    const added = 'const total = computeSum(items);';
    const marked = addIntraLineEmphasis([del(deleted), add(added)]);
    expect(marked).toEqual([
      { kind: 'del', text: deleted, emphasis: { start: 21, end: 26 } },
      { kind: 'add', text: added, emphasis: { start: 21, end: 24 } },
    ]);
    // The spans are exactly the text that differs.
    expect(deleted.slice(21, 26)).toBe('Total');
    expect(added.slice(21, 24)).toBe('Sum');
  });

  it('pairs equal-length runs line by line, in order', () => {
    const marked = addIntraLineEmphasis([del('a = 1'), del('b = 2'), add('a = 10'), add('b = 20')]);
    expect(marked.map((line) => line.emphasis)).toEqual([
      undefined,
      undefined,
      { start: 5, end: 6 },
      { start: 5, end: 6 },
    ]);
  });

  it('leaves runs of unequal length alone, since no line can be said to replace another', () => {
    const lines = [del('foo(a)'), del('foo(b)'), add('foo(c)')];
    expect(addIntraLineEmphasis(lines)).toEqual(lines);
  });

  it('does not pair a deletion with an addition that is not directly after it', () => {
    const lines = [del('x = 1'), context('between'), add('x = 2')];
    expect(addIntraLineEmphasis(lines)).toEqual(lines);
  });

  it('skips a pair that shares no prefix or suffix, where the whole line changed', () => {
    const lines = [del('alpha'), add('omega-')];
    expect(addIntraLineEmphasis(lines)).toEqual(lines);
  });

  it('leaves the span empty on the side that lost nothing', () => {
    const [deleted, added] = addIntraLineEmphasis([del('call(a)'), add('call(a, b)')]);
    expect(deleted.emphasis).toBeUndefined();
    expect(added.emphasis).toEqual({ start: 6, end: 9 });
  });

  it('does not split a surrogate pair that straddles the shared edge', () => {
    // The two emoji share their high surrogate (0xD83D) and differ in the low one.
    const marked = addIntraLineEmphasis([del('x \u{1F600} y'), add('x \u{1F601} y')]);
    expect(marked[0].emphasis).toEqual({ start: 2, end: 4 });
    expect(marked[1].emphasis).toEqual({ start: 2, end: 4 });
    expect('x \u{1F600} y'.slice(2, 4)).toBe('\u{1F600}');
  });

  it('does not mutate its input', () => {
    const lines = [del('a = 1'), add('a = 2')];
    const snapshot = structuredClone(lines);
    addIntraLineEmphasis(lines);
    expect(lines).toEqual(snapshot);
  });

  it('skips a pair when either line is over the length cap', () => {
    const tail = 'x'.repeat(INTRA_LINE_MAX_LINE_LENGTH);
    const long = [del(`a${tail}`), add(`b${tail}`)];
    expect(addIntraLineEmphasis(long)).toEqual(long);

    // At the cap exactly, the pair is still marked.
    const edge = 'x'.repeat(INTRA_LINE_MAX_LINE_LENGTH - 1);
    const marked = addIntraLineEmphasis([del(`a${edge}`), add(`b${edge}`)]);
    expect(marked[0].emphasis).toEqual({ start: 0, end: 1 });
  });

  it('examines at most INTRA_LINE_MAX_PAIRS pairs of a huge diff', () => {
    const pairCount = INTRA_LINE_MAX_PAIRS + 25;
    const lines = [
      ...Array.from({ length: pairCount }, (_, i) => del(`row ${i} old`)),
      ...Array.from({ length: pairCount }, (_, i) => add(`row ${i} new`)),
    ];
    const marked = addIntraLineEmphasis(lines);
    // Each examined pair marks both of its lines; the rest are left plain.
    expect(marked.filter((line) => line.emphasis !== undefined)).toHaveLength(
      INTRA_LINE_MAX_PAIRS * 2
    );
    expect(marked[pairCount - 1].emphasis).toBeUndefined();
    expect(marked[marked.length - 1].emphasis).toBeUndefined();
  });

  it('runs after the line diff, and leaves context lines plain', () => {
    const lines = diffTextLines('keep\nreturn oldName;\nkeep', 'keep\nreturn newName;\nkeep');
    expect(lines.find((line) => line.kind === 'del')?.emphasis).toEqual({ start: 7, end: 10 });
    expect(lines.find((line) => line.kind === 'add')?.emphasis).toEqual({ start: 7, end: 10 });
    expect(lines.find((line) => line.kind === 'context')?.emphasis).toBeUndefined();
  });
});
