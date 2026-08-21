import { describe, expect, it } from 'bun:test';
import { getToolHint } from '@/features/chat/components/ToolCallVisuals';

describe('getToolHint', () => {
  it('returns an abbreviated path for read_file', () => {
    expect(getToolHint('read_file', { path: '/home/ada/notes.md' })).toBe('~/notes.md');
  });

  it('names a byte view for read_file, which returns something unlike file content', () => {
    expect(getToolHint('read_file', { path: '/home/ada/logo.png', view: 'hex' })).toBe(
      '~/logo.png (hex)'
    );
  });

  it('leaves an explicit text view off the read_file hint', () => {
    expect(getToolHint('read_file', { path: '/home/ada/notes.md', view: 'text' })).toBe(
      '~/notes.md'
    );
  });

  it('returns an abbreviated path for write_file', () => {
    expect(getToolHint('write_file', { path: '/home/ada/src/index.ts' })).toBe('~/src/index.ts');
  });

  it('returns an abbreviated path for file editing tools', () => {
    expect(getToolHint('edit_file', { path: '/home/ada/src/index.ts' })).toBe('~/src/index.ts');
    expect(getToolHint('replace_range', { path: '/home/ada/src/app.ts' })).toBe('~/src/app.ts');
  });

  it('returns abbreviated paths for create_file and delete_file', () => {
    expect(getToolHint('create_file', { path: '/home/ada/new.ts' })).toBe('~/new.ts');
    expect(getToolHint('delete_file', { path: '/home/ada/old.ts' })).toBe('~/old.ts');
  });

  it('returns a directional path pair for move_file', () => {
    expect(
      getToolHint('move_file', {
        from: '/home/ada/src/old.ts',
        to: '/home/ada/src/new.ts',
      })
    ).toBe('~/src/old.ts → ~/src/new.ts');
  });

  it('summarizes the first file and remaining scope for apply_patch', () => {
    expect(
      getToolHint('apply_patch', {
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

  it('tolerates partial or malformed apply_patch arguments', () => {
    expect(getToolHint('apply_patch', { patch: '*** Begin Patch\n*** Update File:' })).toBeNull();
    expect(
      getToolHint('apply_patch', {
        patch: '*** Begin Patch\n*** Update File:\n-old\n+new',
      })
    ).toBeNull();
    expect(getToolHint('apply_patch', { patch: 42 })).toBeNull();
  });

  it('returns null when move_file is missing either path', () => {
    expect(getToolHint('move_file', { from: '/home/ada/old.ts' })).toBeNull();
    expect(getToolHint('move_file', { to: '/home/ada/new.ts' })).toBeNull();
  });

  it('returns an abbreviated path for list_directory', () => {
    expect(getToolHint('list_directory', { path: '/var/log' })).toBe('/var/log');
  });

  it('returns the command string for bash', () => {
    expect(getToolHint('bash', { command: 'ls -la' })).toBe('ls -la');
  });

  it('returns the command string for zsh', () => {
    expect(getToolHint('zsh', { command: 'echo hello' })).toBe('echo hello');
  });

  it('returns the command string for powershell', () => {
    expect(getToolHint('powershell', { command: 'Get-ChildItem' })).toBe('Get-ChildItem');
  });

  it('returns null for empty command strings', () => {
    expect(getToolHint('bash', { command: '' })).toBeNull();
    expect(getToolHint('bash', { command: '   ' })).toBeNull();
  });

  it('returns the pattern for grep', () => {
    expect(getToolHint('grep', { pattern: 'import.*React' })).toBe('import.*React');
  });

  it('keeps edge whitespace in a grep pattern, which the API searches verbatim', () => {
    expect(getToolHint('grep', { pattern: ' TODO' })).toBe(' TODO');
    expect(getToolHint('grep', { pattern: '   ' })).toBe('   ');
  });

  it('returns the pattern for glob', () => {
    expect(getToolHint('glob', { pattern: '**/*.ts' })).toBe('**/*.ts');
  });

  it('returns null for empty pattern strings', () => {
    expect(getToolHint('grep', { pattern: '' })).toBeNull();
    expect(getToolHint('glob', { pattern: '   ' })).toBeNull();
  });

  it('returns null for unknown tools', () => {
    expect(getToolHint('custom_tool', { path: '/foo' })).toBeNull();
  });

  it('returns null when the expected arg is missing', () => {
    expect(getToolHint('read_file', {})).toBeNull();
    expect(getToolHint('bash', {})).toBeNull();
    expect(getToolHint('grep', {})).toBeNull();
  });

  it('returns null when path arg is not a string', () => {
    expect(getToolHint('read_file', { path: 42 })).toBeNull();
  });
});
