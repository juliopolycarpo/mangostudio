/**
 * A subagent whose connector still exists but whose key the provider rejects
 * (HTTP 401 or 403) must fail with one typed code that names the agent, the model
 * and the connector to fix, whichever provider it runs on. Before this the parent
 * received the provider's own text under the generic FAILED code.
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
import {
  getProvider,
  invalidateProviderRoutingCache,
  registerProvider,
} from '../../../../src/services/providers/core/provider-registry';
import type { AIProvider } from '../../../../src/services/providers/types';
import { ensureTestUsers, insertTestConnector } from '../../../support/factories';
import {
  KEY_REJECTING_PROVIDER_TYPES,
  KeyRejectingProviderFake,
  UPSTREAM_REJECTION_TEXT,
} from '../../../support/providers/key-rejecting-providers';

const USER_ID = 'user-subagent-credential-rejected';
const PARENT_MODEL = 'parent-chat-model';
const PINNED_MODEL = 'pinned-subagent-model';
const PINNED_CONNECTOR_NAME = 'Team Revoked Key';
const PARENT_CONNECTOR_NAME = 'Parent Chat Key';
const SUBAGENT_ID = 'explore';
const CREDENTIAL_REJECTED_CODE = 'PROVIDER_CREDENTIAL_REJECTED';
const REJECTION_STATUSES = [401, 403] as const;

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
    chatId: 'chat-subagent-credential-rejected',
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

const replacedProviders = new Map<string, AIProvider>();

/** Registers the fake in place of the real adapter, remembering the adapter to restore. */
function installProvider(fake: KeyRejectingProviderFake): void {
  if (!replacedProviders.has(fake.providerType)) {
    replacedProviders.set(fake.providerType, getProvider(fake.providerType));
  }
  registerProvider(fake.asAIProvider());
}

beforeAll(async () => {
  await ensureTestUsers({
    id: USER_ID,
    name: 'Credential Rejected User',
    email: `${USER_ID}@mangostudio.test`,
  });
});

beforeEach(() => {
  clearSubagentCache();
});

afterEach(async () => {
  for (const original of replacedProviders.values()) registerProvider(original);
  replacedProviders.clear();
  await getDb().deleteFrom('secret_metadata').where('userId', '=', USER_ID).execute();
  invalidateProviderRoutingCache(USER_ID);
});

describe.each(KEY_REJECTING_PROVIDER_TYPES)(
  'subagent on %s with a rejected key',
  (providerType) => {
    async function connectPinnedModel(): Promise<void> {
      await insertTestConnector(USER_ID, {
        id: `${USER_ID}-${providerType}-pinned`,
        name: PINNED_CONNECTOR_NAME,
        provider: providerType,
        enabledModels: [PINNED_MODEL],
      });
      await pinSubagentModel(PINNED_MODEL);
    }

    it.each(REJECTION_STATUSES)(
      'fails with the credential-rejected code naming agent, model and connector on HTTP %d',
      async (status) => {
        installProvider(new KeyRejectingProviderFake(providerType, status));
        await connectPinnedModel();

        const result = await runSubagentTurn(delegationInput());

        expect(
          result.error?.code,
          `(${providerType} subagent result, HTTP ${status}): expected ${CREDENTIAL_REJECTED_CODE} | received ${result.error?.code} with message "${result.error?.message}"`
        ).toBe(CREDENTIAL_REJECTED_CODE);
        expect(result.status).toBe('failed');
        expect(result.error?.message).toContain(`"${SUBAGENT_ID}"`);
        expect(result.error?.message).toContain(`"${PINNED_MODEL}"`);
        expect(result.error?.message).toContain(`"${PINNED_CONNECTOR_NAME}"`);
        expect(result.error?.message).toContain(`HTTP ${status}`);
        expect(result.error?.message).toContain('Settings');
        expect(result.error?.message).not.toContain(UPSTREAM_REJECTION_TEXT);
        expect(result.summary).toBe(result.error?.message ?? '');
        expect(result.trace.error).toBe(result.error?.message);
      }
    );

    it('is delivered to the parent once, because a retry cannot fix a key', async () => {
      const fake = new KeyRejectingProviderFake(providerType, 401);
      installProvider(fake);
      await connectPinnedModel();
      let attempts = 0;

      const delivered = await ensureDelegationResult('call-credential', delegationInput().request, {
        timeoutMs: SETTINGS.timeoutMs,
        executeDelegation: () => {
          attempts += 1;
          return runSubagentTurn(delegationInput());
        },
      });

      expect(attempts, `(${providerType} delegation attempts): expected 1`).toBe(1);
      expect(delivered.status).toBe('failed');
      expect(delivered.error?.code).toBe(CREDENTIAL_REJECTED_CODE);
    });
  }
);

describe('subagent that inherits the parent model', () => {
  it('names the connector serving the parent model', async () => {
    installProvider(new KeyRejectingProviderFake('anthropic', 401));
    await insertTestConnector(USER_ID, {
      id: `${USER_ID}-parent`,
      name: PARENT_CONNECTOR_NAME,
      provider: 'anthropic',
      enabledModels: [PARENT_MODEL],
    });
    await insertTestConnector(USER_ID, {
      id: `${USER_ID}-unrelated`,
      name: 'Unrelated Key',
      provider: 'anthropic',
      enabledModels: ['another-model'],
    });
    await pinSubagentModel(undefined);

    const result = await runSubagentTurn(delegationInput());

    expect(result.error?.code).toBe(CREDENTIAL_REJECTED_CODE);
    expect(result.error?.message).toContain(`"${PARENT_MODEL}"`);
    expect(result.error?.message).toContain(`"${PARENT_CONNECTOR_NAME}"`);
    expect(result.error?.message).not.toContain('Unrelated Key');
  });
});
