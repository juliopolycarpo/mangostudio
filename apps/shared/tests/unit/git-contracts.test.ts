import { describe, expect, it } from 'bun:test';
import {
  AddWorktreeBodySchema,
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
  GitWorktreeSchema,
  RemoveWorktreeBodySchema,
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

  it('accepts the two worktree add shapes and nothing between them', () => {
    const base = { chatId: 'chat-1', path: '/work/feature', branch: 'feat/panel' };

    expect(Value.Check(AddWorktreeBodySchema, { ...base, mode: 'new-branch' })).toBe(true);
    expect(Value.Check(AddWorktreeBodySchema, { ...base, mode: 'existing-branch' })).toBe(true);

    // The union is closed: no mode, an invented mode, or a branchless request
    // are all shapes neither Git command could be built from.
    expect(Value.Check(AddWorktreeBodySchema, base)).toBe(false);
    expect(Value.Check(AddWorktreeBodySchema, { ...base, mode: 'detach' })).toBe(false);
    expect(
      Value.Check(AddWorktreeBodySchema, {
        chatId: 'chat-1',
        path: '/work/feature',
        mode: 'new-branch',
      })
    ).toBe(false);
    expect(Value.Check(AddWorktreeBodySchema, { ...base, mode: 'new-branch', path: '' })).toBe(
      false
    );
  });

  it('makes force optional on a worktree removal but the path required', () => {
    expect(Value.Check(RemoveWorktreeBodySchema, { chatId: 'chat-1', path: '/work/x' })).toBe(true);
    expect(
      Value.Check(RemoveWorktreeBodySchema, { chatId: 'chat-1', path: '/work/x', force: true })
    ).toBe(true);
    expect(Value.Check(RemoveWorktreeBodySchema, { chatId: 'chat-1' })).toBe(false);
    expect(Value.Check(RemoveWorktreeBodySchema, { chatId: 'chat-1', path: '' })).toBe(false);
  });

  it('lets a worktree report no HEAD and no branch, as a bare or detached one does', () => {
    const linked = {
      path: '/work/feature',
      head: '0a44a0f9bbf9a15117d5bbc4d543442f2b169d87',
      branch: 'feat/panel',
      isMain: false,
      isBare: false,
      isDetached: false,
      isLocked: false,
      isPrunable: false,
    };

    expect(Value.Check(GitWorktreeSchema, linked)).toBe(true);
    expect(
      Value.Check(GitWorktreeSchema, { ...linked, head: null, branch: null, isBare: true })
    ).toBe(true);
    expect(
      Value.Check(GitWorktreeSchema, {
        ...linked,
        branch: null,
        isDetached: true,
        isLocked: true,
        lockReason: 'held for review',
        isPrunable: true,
        prunableReason: 'gitdir file points to non-existent location',
      })
    ).toBe(true);

    expect(Value.Check(GitWorktreeSchema, { ...linked, head: 'nothex' })).toBe(false);
    expect(Value.Check(GitWorktreeSchema, { ...linked, branch: '' })).toBe(false);
    expect(Value.Check(GitWorktreeSchema, { ...linked, path: '' })).toBe(false);
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
