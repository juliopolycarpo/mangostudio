/**
 * An `ExternalSessionHandle` whose `sendTurn` fails the way a script says,
 * then answers. It counts calls and native submissions, for exercising
 * `submitExternalTurn` without a runtime.
 */

import type { ExternalAgentTurnParams } from '@mangostudio/shared/external-agents';
import { NO_EXTERNAL_AGENT_CAPABILITIES } from '@mangostudio/shared/external-agents';
import type { ExternalSessionHandle } from '../../../src/modules/external-agents/application/external-session-manager';

export interface ScriptedSessionHandle extends ExternalSessionHandle {
  /** Failures to throw from the next `sendTurn` calls, in order. */
  readonly failures: Array<() => Error>;
  readonly sent: ExternalAgentTurnParams[];
  submissions(): number;
}

export function createScriptedSessionHandle(sessionId = 'session-1'): ScriptedSessionHandle {
  const failures: Array<() => Error> = [];
  const sent: ExternalAgentTurnParams[] = [];
  let submitted = 0;
  return {
    failures,
    sent,
    submissions: () => submitted,
    sessionId,
    nativeSessionId: 'native-session-1',
    targetId: 'codex',
    resumed: false,
    effectiveConfiguration: { level: 'default', routing: 'user', workspaceRoots: ['/w'] },
    capabilities: NO_EXTERNAL_AGENT_CAPABILITIES,
    connectionRevision: 1,
    isLive: () => true,
    subscribe: () => () => undefined,
    beginTurn: () => undefined,
    endTurn: () => undefined,
    turnParams: (input) => ({
      sessionId,
      clientMessageId: input.clientMessageId,
      input: input.input,
      configuration: input.configuration,
    }),
    sendTurn(params) {
      sent.push(params);
      const failure = failures.shift();
      if (failure) return Promise.reject(failure());
      submitted += 1;
      return Promise.resolve(`native-turn-${submitted}`);
    },
    startTurn: () => Promise.reject(new Error('startTurn is not scripted; expected sendTurn')),
    respond: () => Promise.resolve(),
    steer: () => Promise.resolve({ accepted: true as const }),
    startReview: () => Promise.reject(new Error('startReview is not scripted')),
    cancel: () => Promise.resolve(),
  };
}
