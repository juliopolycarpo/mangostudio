import { describe, expect, it } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import {
  GIT_SCOPES,
  gitTopic,
  parseGitTopic,
  REALTIME_CLOSE_CODES,
  RealtimeClientMessageSchema,
  RealtimeInvalidateMessageSchema,
  RealtimeServerMessageSchema,
  SETTINGS_SCOPES,
  SETTINGS_TOPIC,
} from '../../src/realtime';

describe('realtime topic helpers', () => {
  it('round-trips settings and git topics', () => {
    expect(SETTINGS_TOPIC).toBe('settings');
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

  it('exposes scope lists derived from schemas', () => {
    expect(SETTINGS_SCOPES).toEqual(['app', 'provider', 'tool']);
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
        topics: [SETTINGS_TOPIC, gitTopic('c1')],
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
  it('accepts ready, pong, invalidate, and error', () => {
    expect(Value.Check(RealtimeServerMessageSchema, { type: 'ready' })).toBe(true);
    expect(Value.Check(RealtimeServerMessageSchema, { type: 'pong' })).toBe(true);
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
