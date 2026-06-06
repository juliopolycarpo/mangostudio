import { describe, expect, it } from 'vitest';
import { getToolHint } from '@/features/chat/components/ToolCallVisuals';

describe('getToolHint', () => {
  it('returns an abbreviated path for read_file', () => {
    expect(getToolHint('read_file', { path: '/home/ada/notes.md' })).toBe('~/notes.md');
  });

  it('returns an abbreviated path for write_file', () => {
    expect(getToolHint('write_file', { path: '/home/ada/src/index.ts' })).toBe('~/src/index.ts');
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
