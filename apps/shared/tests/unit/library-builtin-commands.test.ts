import { describe, expect, it } from 'bun:test';

import {
  BUILT_IN_SLASH_COMMANDS,
  isBuiltInSlashCommand,
  parseBuiltInSlashInvocation,
} from '@mangostudio/shared/library/values';

describe('built-in slash commands', () => {
  it('names the small set the composer acts on itself', () => {
    expect([...BUILT_IN_SLASH_COMMANDS]).toEqual(['clear', 'model']);
  });

  it('recognises a built-in name exactly, never by prefix or case', () => {
    expect(isBuiltInSlashCommand('clear')).toBe(true);
    expect(isBuiltInSlashCommand('model')).toBe(true);
    expect(isBuiltInSlashCommand('clearing')).toBe(false);
    expect(isBuiltInSlashCommand('Clear')).toBe(false);
    expect(isBuiltInSlashCommand('')).toBe(false);
  });

  it('parses a whole prompt that invokes a built-in, with trimmed arguments', () => {
    expect(parseBuiltInSlashInvocation('/clear')).toEqual({ name: 'clear', args: '' });
    expect(parseBuiltInSlashInvocation('/model  gpt-5 mini ')).toEqual({
      name: 'model',
      args: 'gpt-5 mini',
    });
    expect(parseBuiltInSlashInvocation('/model\nfast')).toEqual({ name: 'model', args: 'fast' });
  });

  it('leaves everything else as ordinary text', () => {
    const ordinary = ['/review a.ts', 'please /clear', ' /clear', '/clearall', '/model/x', ''];
    for (const prompt of ordinary) {
      expect(parseBuiltInSlashInvocation(prompt)).toBeNull();
    }
  });
});
