import { describe, expect, it } from 'bun:test';

import Value from 'typebox/value';

import {
  ACTIVITY_TOPIC,
  CHATS_TOPIC,
  ENVIRONMENTS_TOPIC,
  EXTERNAL_AGENTS_TOPIC,
  GIT_SCOPES,
  gitTopic,
  isRepoKey,
  parseGitTopic,
  parseRepoTopic,
  REALTIME_CLOSE_CODES,
  REALTIME_WRITER_ID_HEADER,
  RealtimeClientMessageSchema,
  RealtimeInvalidateMessageSchema,
  RealtimeServerMessageSchema,
  RealtimeWriterIdSchema,
  REPO_KEY_MAX_LENGTH,
  repoTopic,
  SETTINGS_SCOPES,
  SETTINGS_TOPIC,
} from '../../src/realtime';

describe('realtime topic helpers', () => {
  it('round-trips settings and git topics', () => {
    expect(SETTINGS_TOPIC).toBe('settings');
    expect(ENVIRONMENTS_TOPIC).toBe('environments');
    // Separate from the environments topic on purpose: that one means the
    // machine changed and drops the discovery cache, this one means only that a
    // background probe learned something better about a machine that did not.
    expect(EXTERNAL_AGENTS_TOPIC).toBe('external-agents');
    expect(EXTERNAL_AGENTS_TOPIC).not.toBe(ENVIRONMENTS_TOPIC);
    expect(ACTIVITY_TOPIC).toBe('activity');
    // The chat list and the feed each refetch on every frame, so they must not
    // share a topic.
    expect(CHATS_TOPIC).toBe('chats');
    expect(CHATS_TOPIC).not.toBe(ACTIVITY_TOPIC);
    expect(gitTopic('chat-abc')).toBe('git:chat-abc');
    expect(parseGitTopic(gitTopic('chat-abc'))).toBe('chat-abc');
    expect(parseGitTopic('settings')).toBeUndefined();
    expect(parseGitTopic('git:')).toBeUndefined();
  });

  it('rejects empty chat ids before constructing a git topic', () => {
    expect(() => gitTopic('')).toThrow(TypeError);
    expect(() => gitTopic('')).toThrow('chatId must not be empty');
    expect(
      Value.Check(RealtimeInvalidateMessageSchema, {
        type: 'invalidate',
        topic: 'git:',
        scopes: ['state'],
      })
    ).toBe(false);
  });

  it('keeps git helpers and schemas within the topic length bound', () => {
    const maximumChatId = 'c'.repeat(252);
    const oversizedChatId = 'c'.repeat(253);
    const maximumTopic = gitTopic(maximumChatId);
    const oversizedTopic = `git:${oversizedChatId}`;

    expect(maximumTopic).toHaveLength(256);
    expect(parseGitTopic(maximumTopic)).toBe(maximumChatId);
    expect(
      Value.Check(RealtimeInvalidateMessageSchema, {
        type: 'invalidate',
        topic: maximumTopic,
      })
    ).toBe(true);

    expect(() => gitTopic(oversizedChatId)).toThrow(TypeError);
    expect(parseGitTopic(oversizedTopic)).toBeUndefined();
    expect(
      Value.Check(RealtimeInvalidateMessageSchema, {
        type: 'invalidate',
        topic: oversizedTopic,
      })
    ).toBe(false);
  });

  it('round-trips repo topics and rejects keys outside the URL-safe bound', () => {
    const maximumKey = 'k'.repeat(REPO_KEY_MAX_LENGTH);

    expect(repoTopic('Ab3_-xyz')).toBe('repo:Ab3_-xyz');
    expect(parseRepoTopic(repoTopic('Ab3_-xyz'))).toBe('Ab3_-xyz');
    expect(parseRepoTopic(repoTopic(maximumKey))).toBe(maximumKey);
    expect(repoTopic(maximumKey).length).toBeLessThanOrEqual(256);

    for (const badKey of ['', 'has space', 'a:b', 'a/b', 'k'.repeat(REPO_KEY_MAX_LENGTH + 1)]) {
      expect(() => repoTopic(badKey)).toThrow(TypeError);
      expect(parseRepoTopic(`repo:${badKey}`)).toBeUndefined();
    }
    expect(isRepoKey('Ab3_-xyz')).toBe(true);
    expect(isRepoKey('k'.repeat(REPO_KEY_MAX_LENGTH))).toBe(true);
    expect(isRepoKey('')).toBe(false);
    expect(isRepoKey('has space')).toBe(false);
    expect(isRepoKey('k'.repeat(REPO_KEY_MAX_LENGTH + 1))).toBe(false);
    // A repo topic is not a git topic and vice versa: the route picks the
    // authorization rule from whichever parser answers.
    expect(parseRepoTopic('git:chat-1')).toBeUndefined();
    expect(parseGitTopic(repoTopic('abc'))).toBeUndefined();
    expect(parseRepoTopic('settings')).toBeUndefined();
  });

  it('exposes scope lists derived from schemas', () => {
    expect(SETTINGS_SCOPES).toEqual(['app', 'provider', 'tool', 'tool-identity']);
    expect(GIT_SCOPES).toContain('state');
    expect(GIT_SCOPES).toContain('github');
    expect(GIT_SCOPES).toHaveLength(7);
  });
});

describe('realtime client messages', () => {
  it('accepts subscribe, unsubscribe, and ping', () => {
    expect(
      Value.Check(RealtimeClientMessageSchema, {
        type: 'subscribe',
        topics: [SETTINGS_TOPIC, ENVIRONMENTS_TOPIC, gitTopic('c1')],
      })
    ).toBe(true);
    expect(
      Value.Check(RealtimeClientMessageSchema, {
        type: 'unsubscribe',
        topics: ['settings'],
      })
    ).toBe(true);
    expect(Value.Check(RealtimeClientMessageSchema, { type: 'ping' })).toBe(true);
  });

  it('rejects malformed client messages', () => {
    expect(Value.Check(RealtimeClientMessageSchema, { type: 'pong' })).toBe(false);
    expect(Value.Check(RealtimeClientMessageSchema, { type: 'subscribe', topics: [] })).toBe(false);
    expect(
      Value.Check(RealtimeClientMessageSchema, {
        type: 'subscribe',
        topics: ['x'],
        extra: true,
      })
    ).toBe(false);
  });

  it('bounds subscription batches and individual topic lengths', () => {
    expect(
      Value.Check(RealtimeClientMessageSchema, {
        type: 'subscribe',
        topics: Array.from({ length: 32 }, (_, index) => `topic-${index}`),
      })
    ).toBe(true);
    expect(
      Value.Check(RealtimeClientMessageSchema, {
        type: 'subscribe',
        topics: Array.from({ length: 33 }, (_, index) => `topic-${index}`),
      })
    ).toBe(false);
    expect(
      Value.Check(RealtimeClientMessageSchema, {
        type: 'unsubscribe',
        topics: ['t'.repeat(256)],
      })
    ).toBe(true);
    expect(
      Value.Check(RealtimeClientMessageSchema, {
        type: 'unsubscribe',
        topics: ['t'.repeat(257)],
      })
    ).toBe(false);
  });
});

describe('realtime server messages', () => {
  it('accepts ready, pong, subscribed, invalidate, and error', () => {
    expect(Value.Check(RealtimeServerMessageSchema, { type: 'ready' })).toBe(true);
    expect(Value.Check(RealtimeServerMessageSchema, { type: 'pong' })).toBe(true);
    expect(
      Value.Check(RealtimeServerMessageSchema, {
        type: 'subscribed',
        topics: [SETTINGS_TOPIC, ENVIRONMENTS_TOPIC, gitTopic('chat-1')],
      })
    ).toBe(true);
    expect(
      Value.Check(RealtimeServerMessageSchema, {
        type: 'invalidate',
        topic: ENVIRONMENTS_TOPIC,
      })
    ).toBe(true);
    expect(
      Value.Check(RealtimeServerMessageSchema, {
        type: 'invalidate',
        topic: EXTERNAL_AGENTS_TOPIC,
      })
    ).toBe(true);
    expect(
      Value.Check(RealtimeServerMessageSchema, {
        type: 'invalidate',
        topic: ACTIVITY_TOPIC,
      })
    ).toBe(true);
    // The union carries no scopes for this topic: the whole feed is what
    // changed, and there is nothing narrower to name.
    expect(
      Value.Check(RealtimeServerMessageSchema, {
        type: 'invalidate',
        topic: ACTIVITY_TOPIC,
        scopes: ['whatever'],
      })
    ).toBe(false);
    expect(
      Value.Check(RealtimeServerMessageSchema, {
        type: 'invalidate',
        topic: CHATS_TOPIC,
      })
    ).toBe(true);
    // Like the activity topic, the chats topic names no narrower scope.
    expect(
      Value.Check(RealtimeServerMessageSchema, {
        type: 'invalidate',
        topic: CHATS_TOPIC,
        scopes: ['whatever'],
      })
    ).toBe(false);
    expect(
      Value.Check(RealtimeServerMessageSchema, {
        type: 'invalidate',
        topic: SETTINGS_TOPIC,
        scopes: ['app'],
      })
    ).toBe(true);
    expect(
      Value.Check(RealtimeServerMessageSchema, {
        type: 'invalidate',
        topic: gitTopic('chat-1'),
        scopes: ['state'],
      })
    ).toBe(true);
    expect(
      Value.Check(RealtimeServerMessageSchema, {
        type: 'error',
        error: 'Unauthorized',
        code: 'UNAUTHORIZED',
      })
    ).toBe(true);
    expect(
      Value.Check(RealtimeServerMessageSchema, {
        type: 'error',
        error: 'Validation failed',
        code: 'VALIDATION_ERROR',
        details: { field: 'topics' },
      })
    ).toBe(true);
  });

  it('rejects SSE-only error shape (done field)', () => {
    expect(
      Value.Check(RealtimeServerMessageSchema, {
        type: 'error',
        error: 'x',
        done: true,
      })
    ).toBe(false);
  });

  it('validates invalidate as a standalone schema', () => {
    expect(
      Value.Check(RealtimeInvalidateMessageSchema, {
        type: 'invalidate',
        topic: 'settings',
      })
    ).toBe(true);
    expect(
      Value.Check(RealtimeInvalidateMessageSchema, {
        type: 'invalidate',
        topic: '',
      })
    ).toBe(false);
  });

  it('accepts repo invalidations with git scopes and rejects malformed ones', () => {
    const topic = repoTopic('Ab3_-xyz');

    expect(
      Value.Check(RealtimeInvalidateMessageSchema, {
        type: 'invalidate',
        topic,
        scopes: ['state', 'github'],
      })
    ).toBe(true);
    expect(Value.Check(RealtimeInvalidateMessageSchema, { type: 'invalidate', topic })).toBe(true);
    expect(
      Value.Check(RealtimeServerMessageSchema, { type: 'invalidate', topic, scopes: ['branches'] })
    ).toBe(true);

    // Settings scopes, an empty scope list, an empty key, an oversized key and
    // a path-shaped key are all rejected on the wire.
    for (const invalid of [
      { type: 'invalidate', topic, scopes: ['app'] },
      { type: 'invalidate', topic, scopes: [] },
      { type: 'invalidate', topic: 'repo:' },
      { type: 'invalidate', topic: `repo:${'k'.repeat(REPO_KEY_MAX_LENGTH + 1)}` },
      { type: 'invalidate', topic: 'repo:/home/user/project' },
      { type: 'invalidate', topic, chatId: 'chat-1' },
    ]) {
      expect(Value.Check(RealtimeInvalidateMessageSchema, invalid)).toBe(false);
    }
  });

  it('rejects invalidate messages with topic/scope mismatches', () => {
    expect(
      Value.Check(RealtimeInvalidateMessageSchema, {
        type: 'invalidate',
        topic: SETTINGS_TOPIC,
        scopes: ['state'],
      })
    ).toBe(false);
    expect(
      Value.Check(RealtimeInvalidateMessageSchema, {
        type: 'invalidate',
        topic: gitTopic('chat-1'),
        scopes: ['app'],
      })
    ).toBe(false);
    expect(
      Value.Check(RealtimeInvalidateMessageSchema, {
        type: 'invalidate',
        topic: 'unknown-topic',
        scopes: ['app'],
      })
    ).toBe(false);
    // The external-agents topic carries no scopes: the whole descriptor list is
    // what changed, and there is nothing narrower to name.
    expect(
      Value.Check(RealtimeInvalidateMessageSchema, {
        type: 'invalidate',
        topic: EXTERNAL_AGENTS_TOPIC,
        scopes: ['app'],
      })
    ).toBe(false);
    expect(
      Value.Check(RealtimeInvalidateMessageSchema, {
        type: 'invalidate',
        topic: gitTopic('chat-1'),
        scopes: ['not-a-git-scope'],
      })
    ).toBe(false);
    expect(
      Value.Check(RealtimeInvalidateMessageSchema, {
        type: 'invalidate',
        topic: gitTopic('chat-a'),
        scopes: ['state'],
        chatId: 'chat-b',
      })
    ).toBe(false);
  });

  it('carries an optional writer id on settings invalidations only', () => {
    // Optional: an older hub never sends one and its frames must stay valid.
    expect(
      Value.Check(RealtimeInvalidateMessageSchema, {
        type: 'invalidate',
        topic: SETTINGS_TOPIC,
        scopes: ['app'],
      })
    ).toBe(true);
    expect(
      Value.Check(RealtimeInvalidateMessageSchema, {
        type: 'invalidate',
        topic: SETTINGS_TOPIC,
        scopes: ['app'],
        writerId: 'tab-1',
      })
    ).toBe(true);
    expect(
      Value.Check(RealtimeServerMessageSchema, {
        type: 'invalidate',
        topic: SETTINGS_TOPIC,
        writerId: 'w'.repeat(64),
      })
    ).toBe(true);

    for (const writerId of ['', 'w'.repeat(65), 7, null]) {
      expect(
        Value.Check(RealtimeInvalidateMessageSchema, {
          type: 'invalidate',
          topic: SETTINGS_TOPIC,
          writerId,
        })
      ).toBe(false);
    }

    // No other topic has an echo to recognise, so none accepts the field.
    for (const topic of [CHATS_TOPIC, ACTIVITY_TOPIC, ENVIRONMENTS_TOPIC, gitTopic('chat-1')]) {
      expect(
        Value.Check(RealtimeInvalidateMessageSchema, {
          type: 'invalidate',
          topic,
          writerId: 'tab-1',
        })
      ).toBe(false);
    }
  });

  it('names the writer id header in lowercase and bounds the id', () => {
    expect(REALTIME_WRITER_ID_HEADER).toBe('x-mangostudio-writer-id');
    expect(Value.Check(RealtimeWriterIdSchema, 'tab-1')).toBe(true);
    expect(Value.Check(RealtimeWriterIdSchema, '')).toBe(false);
    expect(Value.Check(RealtimeWriterIdSchema, 'w'.repeat(65))).toBe(false);
  });
});

describe('realtime close codes', () => {
  it('exports the stable browser reconnect contract', () => {
    expect(REALTIME_CLOSE_CODES).toEqual({
      INVALID_MESSAGE: 4400,
      UNAUTHORIZED: 4401,
      FORBIDDEN: 4403,
      RATE_LIMITED: 4429,
      INTERNAL_ERROR: 1011,
    });
  });
});
