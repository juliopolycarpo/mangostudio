import { describe, expect, it } from 'bun:test';

import { en } from '@mangostudio/shared/i18n';

import { getToolHint } from '@/features/chat/components/ToolCallVisuals';
import { formatMessage } from '@/lib/i18n-format';

/** The same formatter the chat cards pass: the count string comes from the dictionary. */
function formatMoreCount(count: number): string {
  return formatMessage(en.tools.moreCount, { count: String(count) });
}

function hintOf(toolName: string, args: Record<string, unknown>): string | null {
  return getToolHint(toolName, args, formatMoreCount);
}

describe('getToolHint', () => {
  it('returns an abbreviated path for read_file', () => {
    expect(hintOf('read_file', { path: '/home/ada/notes.md' })).toBe('~/notes.md');
  });

  it('names a byte view for read_file, which returns something unlike file content', () => {
    expect(hintOf('read_file', { path: '/home/ada/logo.png', view: 'hex' })).toBe(
      '~/logo.png (hex)'
    );
  });

  it('leaves an explicit text view off the read_file hint', () => {
    expect(hintOf('read_file', { path: '/home/ada/notes.md', view: 'text' })).toBe('~/notes.md');
  });

  it('returns an abbreviated path for write_file', () => {
    expect(hintOf('write_file', { path: '/home/ada/src/index.ts' })).toBe('~/src/index.ts');
  });

  it('returns an abbreviated path for file editing tools', () => {
    expect(hintOf('edit_file', { path: '/home/ada/src/index.ts' })).toBe('~/src/index.ts');
    expect(hintOf('replace_range', { path: '/home/ada/src/app.ts' })).toBe('~/src/app.ts');
  });

  it('returns abbreviated paths for create_file and delete_file', () => {
    expect(hintOf('create_file', { path: '/home/ada/new.ts' })).toBe('~/new.ts');
    expect(hintOf('delete_file', { path: '/home/ada/old.ts' })).toBe('~/old.ts');
  });

  it('returns a directional path pair for move_file', () => {
    expect(
      hintOf('move_file', {
        from: '/home/ada/src/old.ts',
        to: '/home/ada/src/new.ts',
      })
    ).toBe('~/src/old.ts → ~/src/new.ts');
  });

  it('summarizes the first file and remaining scope for apply_patch', () => {
    expect(
      hintOf('apply_patch', {
        patch: `*** Begin Patch
*** Update File: /home/ada/src/app.ts
-old
+new
*** Add File: /home/ada/src/new.ts
+content
*** Delete File: /home/ada/src/dead.ts
*** End Patch`,
      })
    ).toBe('~/src/app.ts (+2 more)');
  });

  it('words the remaining scope with the formatter it is given, not a built-in string', () => {
    const patch = `*** Begin Patch
*** Update File: /home/ada/a.ts
*** Add File: /home/ada/b.ts
*** Add File: /home/ada/c.ts
*** End Patch`;
    const formatCalls: number[] = [];
    const hint = getToolHint('apply_patch', { patch }, (count) => {
      formatCalls.push(count);
      return `mais ${count}`;
    });
    expect(hint).toBe('~/a.ts (mais 2)');
    expect(formatCalls).toEqual([2]);
  });

  it('tolerates partial or malformed apply_patch arguments', () => {
    expect(hintOf('apply_patch', { patch: '*** Begin Patch\n*** Update File:' })).toBeNull();
    expect(
      hintOf('apply_patch', {
        patch: '*** Begin Patch\n*** Update File:\n-old\n+new',
      })
    ).toBeNull();
    expect(hintOf('apply_patch', { patch: 42 })).toBeNull();
  });

  it('returns null when move_file is missing either path', () => {
    expect(hintOf('move_file', { from: '/home/ada/old.ts' })).toBeNull();
    expect(hintOf('move_file', { to: '/home/ada/new.ts' })).toBeNull();
  });

  it('returns an abbreviated path for list_directory', () => {
    expect(hintOf('list_directory', { path: '/var/log' })).toBe('/var/log');
  });

  it('returns the command string for bash', () => {
    expect(hintOf('bash', { command: 'ls -la' })).toBe('ls -la');
  });

  it('returns the command string for zsh', () => {
    expect(hintOf('zsh', { command: 'echo hello' })).toBe('echo hello');
  });

  it('returns the command string for powershell', () => {
    expect(hintOf('powershell', { command: 'Get-ChildItem' })).toBe('Get-ChildItem');
  });

  it('returns null for empty command strings', () => {
    expect(hintOf('bash', { command: '' })).toBeNull();
    expect(hintOf('bash', { command: '   ' })).toBeNull();
  });

  it('returns the pattern for grep', () => {
    expect(hintOf('grep', { pattern: 'import.*React' })).toBe('import.*React');
  });

  it('keeps edge whitespace in a grep pattern, which the API searches verbatim', () => {
    expect(hintOf('grep', { pattern: ' TODO' })).toBe(' TODO');
    expect(hintOf('grep', { pattern: '   ' })).toBe('   ');
  });

  it('returns the pattern for glob', () => {
    expect(hintOf('glob', { pattern: '**/*.ts' })).toBe('**/*.ts');
  });

  it('returns null for empty pattern strings', () => {
    expect(hintOf('grep', { pattern: '' })).toBeNull();
    expect(hintOf('glob', { pattern: '   ' })).toBeNull();
  });

  it('returns null for unknown tools', () => {
    expect(hintOf('custom_tool', { path: '/foo' })).toBeNull();
  });

  it('returns null when the expected arg is missing', () => {
    expect(hintOf('read_file', {})).toBeNull();
    expect(hintOf('bash', {})).toBeNull();
    expect(hintOf('grep', {})).toBeNull();
  });

  it('returns null when path arg is not a string', () => {
    expect(hintOf('read_file', { path: 42 })).toBeNull();
  });
});
