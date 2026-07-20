import { describe, expect, it } from 'bun:test';
import {
  CommitBodySchema,
  StagePathsBodySchema,
  StashPopBodySchema,
  UnstagePathsBodySchema,
} from '@mangostudio/shared/git';
import { Value } from '@sinclair/typebox/value';

describe('Git write contracts', () => {
  it('accepts either explicit paths or the all-files selector', () => {
    expect(Value.Check(StagePathsBodySchema, { chatId: 'chat-1', paths: ['src/index.ts'] })).toBe(
      true
    );
    expect(Value.Check(StagePathsBodySchema, { chatId: 'chat-1', all: true })).toBe(true);
    expect(Value.Check(UnstagePathsBodySchema, { chatId: 'chat-1', paths: ['src/index.ts'] })).toBe(
      true
    );
    expect(Value.Check(UnstagePathsBodySchema, { chatId: 'chat-1', all: true })).toBe(true);

    expect(Value.Check(StagePathsBodySchema, { chatId: 'chat-1', paths: [] })).toBe(false);
    expect(Value.Check(StagePathsBodySchema, { chatId: 'chat-1' })).toBe(false);
  });

  it('constrains commit titles after surrounding whitespace is removed', () => {
    expect(Value.Check(CommitBodySchema, { chatId: 'chat-1', title: '  concise title  ' })).toBe(
      true
    );
    expect(Value.Check(CommitBodySchema, { chatId: 'chat-1', title: '   ' })).toBe(false);
    expect(Value.Check(CommitBodySchema, { chatId: 'chat-1', title: 'x'.repeat(73) })).toBe(false);
  });

  it('defaults stash selection at the application boundary while rejecting negative indexes', () => {
    expect(Value.Check(StashPopBodySchema, { chatId: 'chat-1' })).toBe(true);
    expect(Value.Check(StashPopBodySchema, { chatId: 'chat-1', index: 2 })).toBe(true);
    expect(Value.Check(StashPopBodySchema, { chatId: 'chat-1', index: -1 })).toBe(false);
  });
});
