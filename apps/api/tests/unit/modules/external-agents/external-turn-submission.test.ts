import { beforeEach, describe, expect, it } from 'bun:test';
import { RemoteError } from '@mangostudio/protocol';
import { sql } from 'kysely';
import { getDb } from '../../../../src/db/database';
import {
  fingerprintTurnParams,
  submitExternalTurn,
} from '../../../../src/modules/external-agents/application/external-turn-submission';
import { DEFAULT_RETRY_POLICY } from '../../../../src/modules/external-agents/domain/external-turn-retry-policy';
import { listAttemptsForMessage } from '../../../../src/modules/external-agents/infrastructure/external-turn-attempt-repository';
import {
  RuntimeRequestNoReplyError,
  RuntimeRequestNotSentError,
} from '../../../../src/services/runtime-client/request-not-sent';
import { createFakeBackoffClock } from '../../../support/external-agents/fake-backoff-clock';
import { createScriptedSessionHandle } from '../../../support/external-agents/scripted-session-handle';
import { insertTestUser } from '../../../support/factories';

let userId = '';
let chatId = '';
let messageId = '';

beforeEach(async () => {
  userId = (await insertTestUser()).id;
  chatId = `chat-${crypto.randomUUID()}`;
  messageId = `message-${crypto.randomUUID()}`;
  await getDb()
    .insertInto('chats')
    .values({
      id: chatId,
      title: 'chat',
      createdAt: 1,
      updatedAt: 1,
      model: null,
      userId,
      runnerKind: 'external',
      runnerTargetId: 'codex',
      workdir: '/w',
      environmentId: 'local',
    })
    .execute();
});

function submit(
  handle = createScriptedSessionHandle(),
  clock = createFakeBackoffClock({ auto: true }),
  lateAcceptances: string[] = []
) {
  const signal = new AbortController().signal;
  let clockMs = 1_000;
  return {
    handle,
    clock,
    outcome: submitExternalTurn({
      db: getDb(),
      messageId,
      chatId,
      userId,
      environmentId: 'local',
      turn: {
        clientMessageId: 'client-1',
        input: 'hi',
        configuration: { level: 'default', routing: 'user', workspaceRoots: ['/w'] },
      },
      handle,
      reacquire: () => Promise.resolve(handle),
      isTerminalConnectFailure: () => false,
      signal,
      policy: DEFAULT_RETRY_POLICY,
      now: () => {
        clockMs += 1;
        return clockMs;
      },
      newId: () => `attempt-${crypto.randomUUID()}`,
      random: () => 0.5,
      sleep: clock.sleep,
      onLateAcceptance: (_handle, nativeTurnId) => {
        lateAcceptances.push(nativeTurnId);
      },
    }),
  };
}

describe('submitExternalTurn', () => {
  it('(d) replays a never-written request past five failures with no count cap and submits once', async () => {
    const handle = createScriptedSessionHandle();
    for (let index = 0; index < 8; index += 1) {
      handle.failures.push(() => new RuntimeRequestNotSentError('external-agent.turn', undefined));
    }
    const { clock, outcome } = submit(handle);
    const result = await outcome;

    expect(result.kind).toBe('accepted');
    expect({ calls: handle.sent.length, submissions: handle.submissions() }).toEqual({
      calls: 9,
      submissions: 1,
    });
    expect(clock.waits.length).toBe(8);
    expect(Math.max(...clock.waits)).toBeLessThanOrEqual(DEFAULT_RETRY_POLICY.maxDelayMs);
    const states = (await listAttemptsForMessage(messageId, getDb())).map((row) => row.state);
    expect(states).toEqual([...Array(8).fill('not-submitted'), 'accepted']);
  });

  it("replays a runtime's own not-submitted answer", async () => {
    const handle = createScriptedSessionHandle();
    handle.failures.push(
      () => new RemoteError('UNAVAILABLE', 'not dispatched', { dispatch: 'not-submitted' })
    );
    const result = await submit(handle).outcome;
    expect(result.kind).toBe('accepted');
    expect(handle.submissions()).toBe(1);
  });

  it('persists the digest of the exact params, not the params', async () => {
    const handle = createScriptedSessionHandle();
    await submit(handle).outcome;
    const [row] = await listAttemptsForMessage(messageId, getDb());
    const [params] = handle.sent;
    if (!params) throw new Error('expected one sent params object | received: none');
    expect(row?.inputFingerprint).toBe(fingerprintTurnParams(params));
    expect(JSON.stringify(row)).not.toContain('"input":"hi"');
  });

  it('treats a never-written resend of an already-sent attempt as unresolved', async () => {
    const handle = createScriptedSessionHandle();
    handle.failures.push(
      () => new RuntimeRequestNoReplyError(new RemoteError('TIMEOUT', 'no reply'), 'deadline'),
      () => new RuntimeRequestNotSentError('external-agent.turn', undefined)
    );
    const result = await submit(handle).outcome;
    expect(result.kind).toBe('unresolved');
    expect(handle.submissions()).toBe(0);
  });

  it('cancels the vendor turn when recording its acceptance fails, then fails loudly', async () => {
    await sql`CREATE TRIGGER refuse_acceptance BEFORE UPDATE OF state ON external_turn_attempts WHEN NEW.state = 'accepted' BEGIN SELECT RAISE(ABORT, 'acceptance write refused'); END`.execute(
      getDb()
    );
    try {
      const lateAcceptances: string[] = [];
      const { outcome } = submit(undefined, undefined, lateAcceptances);
      const error = await outcome.then(
        () => undefined,
        (e: unknown) => e
      );
      expect(String(error)).toContain('acceptance write refused');
      expect(lateAcceptances).toEqual(['native-turn-1']);
    } finally {
      await sql`DROP TRIGGER IF EXISTS refuse_acceptance`.execute(getDb());
    }
  });
});
