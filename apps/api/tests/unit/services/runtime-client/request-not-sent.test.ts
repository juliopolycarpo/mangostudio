import { describe, expect, it } from 'bun:test';
import { RemoteError } from '@mangostudio/protocol';
import {
  isRequestNotSent,
  RuntimeRequestNotSentError,
} from '../../../../src/services/runtime-client/request-not-sent';
import { connectTestRuntime } from '../../../support/runtime-fixture';

const TURN_PARAMS = {
  sessionId: 'session-1',
  clientMessageId: 'message-1',
  input: 'hello',
  configuration: { level: 'default', routing: 'user', workspaceRoots: ['/work'] },
} as const;

describe('RuntimeRequestNotSentError', () => {
  it('is thrown, with zero runtime calls, when the session closed before the request', async () => {
    let received = 0;
    const runtime = await connectTestRuntime({
      handlers: {
        'external-agent.turn': () => {
          received += 1;
          return { nativeTurnId: 'native-1' };
        },
      },
    });
    await runtime.close();

    const error = await runtime.client.externalAgents.turn(TURN_PARAMS).catch((e: unknown) => e);

    expect(isRequestNotSent(error)).toBe(true);
    expect(error).toBeInstanceOf(RemoteError);
    expect((error as RemoteError).code).toBe('UNAVAILABLE');
    expect(received).toBe(0);
  });

  it('is not thrown when the frame was written and the session closed before the reply', async () => {
    let received = 0;
    const arrived = Promise.withResolvers<void>();
    const runtime = await connectTestRuntime({
      handlers: {
        'external-agent.turn': () => {
          received += 1;
          arrived.resolve();
          return new Promise(() => undefined);
        },
      },
    });

    const pending = runtime.client.externalAgents.turn(TURN_PARAMS).catch((e: unknown) => e);
    await arrived.promise;
    await runtime.close();
    const error = await pending;

    expect(received).toBe(1);
    expect(error).toBeInstanceOf(RemoteError);
    expect(isRequestNotSent(error)).toBe(false);
  });

  it('names the method and the expected state in its message', () => {
    const error = new RuntimeRequestNotSentError('external-agent.turn', undefined);
    expect(error.message).toContain('external-agent.turn');
    expect(error.message).toContain('expected an open session');
  });
});
