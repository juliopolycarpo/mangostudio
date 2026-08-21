import { describe, expect, it } from 'bun:test';
import type { RealtimeServerMessage } from '@mangostudio/shared/realtime';
import { parseServerMessage } from '@/lib/realtime/parse-server-message';

const VALID_FRAMES: readonly RealtimeServerMessage[] = [
  { type: 'ready' },
  { type: 'pong' },
  { type: 'subscribed', topics: ['settings'] },
  { type: 'subscribed', topics: ['settings', 'git:chat-1'] },
  { type: 'invalidate', topic: 'settings' },
  { type: 'invalidate', topic: 'settings', scopes: ['app', 'provider'] },
  { type: 'invalidate', topic: 'git:chat-1' },
  { type: 'invalidate', topic: 'git:chat-1', scopes: ['state', 'diffs'] },
  { type: 'error', error: 'Unsupported realtime topic' },
  { type: 'error', error: 'Realtime topic is unavailable', code: 'NOT_FOUND' },
];

describe('parseServerMessage', () => {
  it.each(VALID_FRAMES.map((frame) => [JSON.stringify(frame), frame] as const))(
    'round-trips %s',
    (serialized, frame) => {
      expect(parseServerMessage(serialized)).toEqual(frame);
    }
  );

  const REJECTED: readonly [string, unknown][] = [
    ['non-string data', { type: 'ready' }],
    ['a numeric payload', 42],
    ['undefined', undefined],
    ['malformed JSON', '{"type":"ready"'],
    ['JSON null', 'null'],
    ['a JSON array', '[{"type":"ready"}]'],
    ['a missing type', '{"topics":["settings"]}'],
    ['a non-string type', '{"type":7}'],
    ['an unknown type', '{"type":"welcome"}'],
    ['subscribed without topics', '{"type":"subscribed"}'],
    ['subscribed with empty topics', '{"type":"subscribed","topics":[]}'],
    ['subscribed with a non-string topic', '{"type":"subscribed","topics":[1]}'],
    ['subscribed with an empty topic string', '{"type":"subscribed","topics":[""]}'],
    ['subscribed with a non-array topics', '{"type":"subscribed","topics":"settings"}'],
    ['invalidate without a topic', '{"type":"invalidate"}'],
    ['invalidate with an empty topic', '{"type":"invalidate","topic":""}'],
    ['invalidate with a non-string topic', '{"type":"invalidate","topic":[1]}'],
    ['invalidate with empty scopes', '{"type":"invalidate","topic":"settings","scopes":[]}'],
    ['invalidate with a non-string scope', '{"type":"invalidate","topic":"settings","scopes":[1]}'],
    ['error without a message', '{"type":"error"}'],
    ['error with a non-string message', '{"type":"error","error":{}}'],
    ['error with a non-string code', '{"type":"error","error":"nope","code":7}'],
  ];

  it.each(REJECTED)('rejects %s', (_label, data) => {
    expect(parseServerMessage(data)).toBeNull();
  });

  it('forwards a scope the current contract does not know', () => {
    // Forward compatibility: a newer server adding a scope must not cost this
    // client the whole frame, so scopes are shape-checked, not enumerated.
    // `expect<unknown>` because bun-types types `toEqual` against the received
    // type, and the whole point here is a scope the contract does not list.
    expect<unknown>(
      parseServerMessage('{"type":"invalidate","topic":"git:c1","scopes":["worktrees"]}')
    ).toEqual({ type: 'invalidate', topic: 'git:c1', scopes: ['worktrees'] });
  });

  it('ignores unknown extra properties', () => {
    expect(parseServerMessage('{"type":"ready","serverVersion":"9"}')).toEqual({ type: 'ready' });
    expect(parseServerMessage('{"type":"subscribed","topics":["settings"],"at":1}')).toEqual({
      type: 'subscribed',
      topics: ['settings'],
    });
  });

  it('omits absent optional fields rather than setting them undefined', () => {
    expect(parseServerMessage('{"type":"invalidate","topic":"settings"}')).not.toHaveProperty(
      'scopes'
    );
    expect(parseServerMessage('{"type":"error","error":"nope"}')).not.toHaveProperty('code');
  });
});
