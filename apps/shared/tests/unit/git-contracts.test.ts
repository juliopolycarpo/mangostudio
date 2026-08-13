import { describe, expect, it } from 'bun:test';
import {
  CommitBodySchema,
  CreateBranchBodySchema,
  DeleteBranchBodySchema,
  DiscardPathsBodySchema,
  GenerateCommitMessageBodySchema,
  GenerateCommitMessageResponseSchema,
  GitDiffQuerySchema,
  GitHeadMessageResponseSchema,
  GitHistoryQuerySchema,
  GitPushBodySchema,
  RenameBranchBodySchema,
  StagePathsBodySchema,
  StashApplyBodySchema,
  StashDropBodySchema,
  StashPopBodySchema,
  SwitchBranchBodySchema,
  UnstagePathsBodySchema,
} from '@mangostudio/shared/git';
import Value from 'typebox/value';

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

  it('requires an explicit discard mode with at least one path', () => {
    expect(
      Value.Check(DiscardPathsBodySchema, {
        chatId: 'chat-1',
        paths: ['src/panel.tsx'],
        mode: 'tracked',
      })
    ).toBe(true);
    expect(
      Value.Check(DiscardPathsBodySchema, {
        chatId: 'chat-1',
        paths: ['scratch.ts'],
        mode: 'untracked',
      })
    ).toBe(true);
    expect(
      Value.Check(DiscardPathsBodySchema, { chatId: 'chat-1', paths: [], mode: 'tracked' })
    ).toBe(false);
    expect(
      Value.Check(DiscardPathsBodySchema, {
        chatId: 'chat-1',
        paths: ['src/panel.tsx'],
        mode: 'staged',
      })
    ).toBe(false);
  });

  it('constrains commit titles after surrounding whitespace is removed', () => {
    expect(Value.Check(CommitBodySchema, { chatId: 'chat-1', title: '  concise title  ' })).toBe(
      true
    );
    expect(Value.Check(CommitBodySchema, { chatId: 'chat-1', title: '   ' })).toBe(false);
    expect(Value.Check(CommitBodySchema, { chatId: 'chat-1', title: 'x'.repeat(73) })).toBe(false);
  });

  it('validates commit-message generation requests and responses', () => {
    expect(Value.Check(GenerateCommitMessageBodySchema, { chatId: 'chat-1' })).toBe(true);
    expect(
      Value.Check(GenerateCommitMessageBodySchema, { chatId: 'chat-1', model: 'fast-model' })
    ).toBe(true);
    expect(Value.Check(GenerateCommitMessageBodySchema, { chatId: 'chat-1', model: '' })).toBe(
      false
    );
    expect(
      Value.Check(GenerateCommitMessageResponseSchema, {
        title: 'feat(git): generate commit messages',
        body: 'Use the staged diff as context.',
        truncated: false,
      })
    ).toBe(true);
  });

  it('defaults stash selection at the application boundary while rejecting negative indexes', () => {
    expect(Value.Check(StashPopBodySchema, { chatId: 'chat-1' })).toBe(true);
    expect(Value.Check(StashPopBodySchema, { chatId: 'chat-1', index: 2 })).toBe(true);
    expect(Value.Check(StashPopBodySchema, { chatId: 'chat-1', index: -1 })).toBe(false);
  });

  it('validates branch, history, and diff navigation inputs', () => {
    expect(Value.Check(SwitchBranchBodySchema, { chatId: 'chat-1', name: 'feat/history' })).toBe(
      true
    );
    expect(Value.Check(CreateBranchBodySchema, { chatId: 'chat-1', name: '' })).toBe(false);
    expect(Value.Check(GitHistoryQuerySchema, { chatId: 'chat-1', cursor: '20' })).toBe(true);
    expect(Value.Check(GitHistoryQuerySchema, { chatId: 'chat-1', cursor: '-1' })).toBe(false);
    expect(
      Value.Check(GitDiffQuerySchema, {
        chatId: 'chat-1',
        path: 'src/panel.tsx',
        commit: 'abcdef1',
      })
    ).toBe(true);
    expect(Value.Check(GitDiffQuerySchema, { chatId: 'chat-1', path: '../secret' })).toBe(true);
  });

  it('shares the stash-pop selector shape with apply and drop', () => {
    for (const schema of [StashApplyBodySchema, StashDropBodySchema]) {
      expect(Value.Check(schema, { chatId: 'chat-1' })).toBe(true);
      expect(Value.Check(schema, { chatId: 'chat-1', index: 3 })).toBe(true);
      expect(Value.Check(schema, { chatId: 'chat-1', index: -1 })).toBe(false);
      expect(Value.Check(schema, { index: 0 })).toBe(false);
    }
  });

  it('validates branch delete and rename administration bodies', () => {
    expect(Value.Check(DeleteBranchBodySchema, { chatId: 'chat-1', name: 'feat/old' })).toBe(true);
    expect(
      Value.Check(DeleteBranchBodySchema, { chatId: 'chat-1', name: 'feat/old', force: true })
    ).toBe(true);
    expect(Value.Check(DeleteBranchBodySchema, { chatId: 'chat-1', name: '' })).toBe(false);

    expect(
      Value.Check(RenameBranchBodySchema, {
        chatId: 'chat-1',
        name: 'feat/old',
        newName: 'feat/new',
      })
    ).toBe(true);
    expect(Value.Check(RenameBranchBodySchema, { chatId: 'chat-1', name: 'feat/old' })).toBe(false);
    expect(
      Value.Check(RenameBranchBodySchema, { chatId: 'chat-1', name: 'feat/old', newName: '' })
    ).toBe(false);
  });

  it('allows a leased force push and rejects any other forced form', () => {
    expect(Value.Check(GitPushBodySchema, { chatId: 'chat-1' })).toBe(true);
    expect(Value.Check(GitPushBodySchema, { chatId: 'chat-1', force: 'with-lease' })).toBe(true);
    expect(Value.Check(GitPushBodySchema, { chatId: 'chat-1', force: true })).toBe(false);
    expect(Value.Check(GitPushBodySchema, { chatId: 'chat-1', force: 'force' })).toBe(false);
  });

  it('describes the HEAD message used to prefill an amend', () => {
    expect(
      Value.Check(GitHeadMessageResponseSchema, {
        hash: 'abcdef1234567890',
        title: 'feat(git): amend from the panel',
        body: 'Explain the change.',
      })
    ).toBe(true);
    expect(
      Value.Check(GitHeadMessageResponseSchema, { hash: 'nothex', title: 'x', body: '' })
    ).toBe(false);
  });
});
