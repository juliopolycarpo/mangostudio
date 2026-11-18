/**
 * A subagent pinned to a model keeps that pin after the connector serving it is
 * revoked or removed. The delegation must fail with a typed error that names the
 * agent and the model, reach the parent as a result it can recover from, and never
 * run the task on another provider's model behind the user's back.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import { BUILT_IN_DEFAULT_AGENT } from '@mangostudio/shared/agents';
import type { MultiAgentSettings } from '@mangostudio/shared/app-settings';
import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';

import { getDb } from '../../../../src/db/database';
import { updateAgentProfile } from '../../../../src/modules/agents/application/agent-settings-service';
import { ensureDelegationResult } from '../../../../src/modules/generation/application/delegation-retry';
import { clearSubagentCache } from '../../../../src/modules/generation/application/subagent-response-cache';
import {
  runSubagentTurn,
  type SubagentRuntimeInput,
} from '../../../../src/modules/generation/application/subagent-runner';
import { SUBAGENT_MODEL_UNAVAILABLE_CODE } from '../../../../src/modules/generation/application/subagent-turn-types';
import {
  getProvider,
  invalidateProviderRoutingCache,
  registerProvider,
} from '../../../../src/services/providers/core/provider-registry';
import type {
  AgentEvent,
  AgentTurnRequest,
  AIProvider,
} from '../../../../src/services/providers/types';
import { ensureTestUsers, insertTestConnector } from '../../../support/factories';

const USER_ID = 'user-subagent-pinned-model-unavailable';
const PARENT_MODEL = 'parent-chat-model';
const PINNED_MODEL = 'pinned-subagent-model';
const SUBAGENT_ID = 'explore';

/**
 * Stands in for the provider both models route to. Records every model the agent
 * stream is asked to run, so a test can tell "failed before running" apart from
 * "ran on the wrong model and failed anyway".
 */
class ModelRecordingProvider implements AIProvider {
  readonly providerType = 'openai-compatible' as const;
  readonly requestedModels: string[] = [];

  generateText: AIProvider['generateText'] = () => Promise.resolve({ text: '' });
  listModels: AIProvider['listModels'] = () => Promise.resolve([]);
  validateApiKey: AIProvider['validateApiKey'] = () => Promise.resolve();
  resolveApiKey: AIProvider['resolveApiKey'] = () => Promise.resolve('fake-api-key');

  generateAgentTurnStream = (request: AgentTurnRequest): AsyncIterable<AgentEvent> =>
    this.streamAnswer(request);

  private async *streamAnswer(request: AgentTurnRequest): AsyncGenerator<AgentEvent> {
    await Promise.resolve();
    this.requestedModels.push(request.modelName);
    yield { type: 'assistant_text_delta', text: `ran on ${request.modelName}` };
    yield { type: 'turn_completed' };
  }
}

const SETTINGS: MultiAgentSettings = {
  enabled: true,
  traceVisibility: 'full',
  maxDepth: 2,
  maxSubagentCalls: 5,
  timeoutMs: 15_000,
  defaultMaxTurns: 2,
};

function delegationInput(): SubagentRuntimeInput {
  return {
    db: getDb(),
    userId: USER_ID,
    chatId: 'chat-subagent-pinned-model',
    environmentId: LOCAL_ENVIRONMENT_ID,
    parentAgentProfile: { ...BUILT_IN_DEFAULT_AGENT, subagentIds: [SUBAGENT_ID] },
    parentModelName: PARENT_MODEL,
    settings: SETTINGS,
    request: { agentId: SUBAGENT_ID, task: 'Look at the shared boundary.' },
    depth: 0,
  };
}

/** Pins (or, with `undefined`, unpins) the model on the built-in Explore agent. */
async function pinSubagentModel(model: string | undefined): Promise<void> {
  await updateAgentProfile(getDb(), USER_ID, SUBAGENT_ID, {
    name: 'Explore',
    description: 'Bounded research.',
    role: 'subagent',
    systemPrompt: 'Explore.',
    ...(model ? { model } : {}),
    toolNames: [],
    toolsEnabled: false,
    subagentIds: [],
    metadata: {},
  });
}

/** Removes a connector the way `removeConnector` does: row gone, routing cache dropped. */
async function revokeConnector(connectorId: string): Promise<void> {
  await getDb().deleteFrom('secret_metadata').where('id', '=', connectorId).execute();
  invalidateProviderRoutingCache(USER_ID);
}

let previousProvider: AIProvider;
let provider: ModelRecordingProvider;
let pinnedConnectorId: string;

beforeAll(async () => {
  await ensureTestUsers({
    id: USER_ID,
    name: 'Pinned Model User',
    email: `${USER_ID}@mangostudio.test`,
  });
});

beforeEach(async () => {
  clearSubagentCache();
  previousProvider = getProvider('openai-compatible');
  provider = new ModelRecordingProvider();
  registerProvider(provider);
  await insertTestConnector(USER_ID, {
    id: `${USER_ID}-parent-connector`,
    enabledModels: [PARENT_MODEL],
  });
  pinnedConnectorId = `${USER_ID}-pinned-connector`;
  await insertTestConnector(USER_ID, { id: pinnedConnectorId, enabledModels: [PINNED_MODEL] });
  await pinSubagentModel(PINNED_MODEL);
});

afterEach(async () => {
  registerProvider(previousProvider);
  await getDb().deleteFrom('secret_metadata').where('userId', '=', USER_ID).execute();
  invalidateProviderRoutingCache(USER_ID);
});

describe('subagent pinned to a model whose connector was revoked', () => {
  it('runs on the pinned model while its connector exists', async () => {
    const result = await runSubagentTurn(delegationInput());

    expect(
      { status: result.status, summary: result.summary },
      '(subagent with a live pinned connector): expected status completed on the pinned model'
    ).toEqual({ status: 'completed', summary: `ran on ${PINNED_MODEL}` });
    expect(provider.requestedModels).toEqual([PINNED_MODEL]);
  });

  it('fails with a typed error naming the agent and the pinned model', async () => {
    await revokeConnector(pinnedConnectorId);

    const result = await runSubagentTurn(delegationInput());

    expect(
      result.error?.code,
      `(subagent result error code): expected ${SUBAGENT_MODEL_UNAVAILABLE_CODE} | received ${result.error?.code} with message "${result.error?.message}"`
    ).toBe(SUBAGENT_MODEL_UNAVAILABLE_CODE);
    expect(result.status).toBe('failed');
    expect(result.error?.message).toContain(`"${SUBAGENT_ID}"`);
    expect(result.error?.message).toContain(`"${PINNED_MODEL}"`);
    expect(result.error?.message).toContain('Settings');
    expect(result.error?.message).not.toContain('[registry]');
    expect(result.summary).toBe(result.error?.message ?? '');
    expect(result.trace.error).toBe(result.error?.message);
  });

  it('does not fall back to the parent model, which still has a connector', async () => {
    await revokeConnector(pinnedConnectorId);

    await runSubagentTurn(delegationInput());

    expect(
      provider.requestedModels,
      '(models the provider was asked to run): expected none after the pinned connector was revoked'
    ).toEqual([]);
  });

  it('reports the revocation on the next delegation after a successful one', async () => {
    const before = await runSubagentTurn(delegationInput());
    await revokeConnector(pinnedConnectorId);
    const after = await runSubagentTurn(delegationInput());

    expect(before.status).toBe('completed');
    expect(after.error?.code).toBe(SUBAGENT_MODEL_UNAVAILABLE_CODE);
    expect(provider.requestedModels).toEqual([PINNED_MODEL]);
  });

  it('is a result the parent can recover from, delivered once without retries', async () => {
    await revokeConnector(pinnedConnectorId);
    let attempts = 0;

    const delivered = await ensureDelegationResult('call-pinned-model', delegationInput().request, {
      timeoutMs: SETTINGS.timeoutMs,
      executeDelegation: () => {
        attempts += 1;
        return runSubagentTurn(delegationInput());
      },
    });

    expect(attempts, '(delegation attempts): expected 1, retries cannot restore a connector').toBe(
      1
    );
    expect(delivered.status).toBe('failed');
    expect(delivered.error?.code).toBe(SUBAGENT_MODEL_UNAVAILABLE_CODE);
    expect(delivered.summary).toContain(PINNED_MODEL);
  });

  it('leaves an unpinned subagent on the parent model', async () => {
    await pinSubagentModel(undefined);
    await revokeConnector(pinnedConnectorId);

    const result = await runSubagentTurn(delegationInput());

    expect(result.status).toBe('completed');
    expect(provider.requestedModels).toEqual([PARENT_MODEL]);
  });
});
