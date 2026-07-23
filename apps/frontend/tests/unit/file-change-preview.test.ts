import { describe, expect, it } from 'vitest';
import {
  buildFileChangePreview,
  DIFF_PREVIEW_MAX_LINES,
  findLatestFileChangeId,
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
      { kind: 'add', text: 'const b = 20;' },
      { kind: 'context', text: 'const c = 3;' },
    ]);
    expect(preview?.files[0]?.added).toBe(1);
    expect(preview?.files[0]?.removed).toBe(1);
    expect(preview?.repeatCount).toBeUndefined();
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
        { kind: 'del', text: 'old line' },
        { kind: 'add', text: 'new line' },
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
