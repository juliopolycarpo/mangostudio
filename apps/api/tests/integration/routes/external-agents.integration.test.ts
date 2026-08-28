import { afterEach, describe, expect, it } from 'bun:test';
import type {
  ExternalAgentCapabilities,
  ExternalAgentDescriptor,
  ExternalAgentDescriptorListResponse,
  ExternalSupportedConfiguration,
} from '@mangostudio/shared/external-agents';
import {
  ExternalAgentDescriptorListResponseSchema,
  NO_EXTERNAL_AGENT_CAPABILITIES,
} from '@mangostudio/shared/external-agents';
import Value from 'typebox/value';
import type { ProbeScope } from '../../../src/modules/environments/application/probing-service';
import type {
  DescribeExternalAgentsOptions,
  DiscoveredExternalAgent,
  ExternalAgentDiscoveryService,
} from '../../../src/modules/external-agents/application/external-agent-discovery';
import { createExternalAgentRoutes } from '../../../src/modules/external-agents/http/external-agent-routes';
import { insertTestUser } from '../../support/factories';
import {
  createApiTestApp,
  createAuthenticatedApiTestApp,
} from '../../support/harness/create-api-test-app';

const TEST_USER = {
  id: 'external-agents-routes-user',
  name: 'External Agents Routes User',
  email: 'external-agents-routes@mangostudio.test',
};

let restoreAuth: (() => void) | null = null;

afterEach(() => {
  restoreAuth?.();
  restoreAuth = null;
});

/** What an adapter that answered reports: real flags and a real permission matrix. */
const ADAPTER_CAPABILITIES: ExternalAgentCapabilities = {
  ...NO_EXTERNAL_AGENT_CAPABILITIES,
  structuredStreaming: true,
  cancellation: true,
};

const ADAPTER_CONFIGURATIONS: readonly ExternalSupportedConfiguration[] = [
  { level: 'default', routing: 'user', supported: true, unattended: false, vendorId: 'default' },
];

function descriptorFor(
  environmentId: string,
  overrides: Partial<ExternalAgentDescriptor> = {}
): ExternalAgentDescriptor {
  return {
    targetId: 'codex',
    environmentId,
    installed: true,
    version: '0.147.0',
    authState: 'signed-in',
    capabilities: NO_EXTERNAL_AGENT_CAPABILITIES,
    supportedConfigurations: [],
    ...overrides,
  };
}

/**
 * Discovery as the routes see it: one target, and a switch for whether an
 * adapter answered for it.
 *
 * The switch is the whole point of these tests. The descriptor the cheap pass
 * produces and the descriptor a refusing adapter produces are byte-identical —
 * every capability false — so nothing downstream can tell them apart without
 * the flag this fake carries.
 */
class FakeDiscovery implements Pick<ExternalAgentDiscoveryService, 'describeExternalAgents'> {
  readonly scopes: ProbeScope[] = [];
  readonly waited: boolean[] = [];
  adapterAnswered = false;

  describeExternalAgents(
    scope: ProbeScope,
    options: DescribeExternalAgentsOptions = {}
  ): Promise<readonly DiscoveredExternalAgent[]> {
    this.scopes.push(scope);
    this.waited.push(options.waitForAdapter === true);
    const descriptor = this.adapterAnswered
      ? descriptorFor(scope.environmentId, {
          capabilities: ADAPTER_CAPABILITIES,
          supportedConfigurations: ADAPTER_CONFIGURATIONS,
        })
      : descriptorFor(scope.environmentId);
    return Promise.resolve([{ descriptor, adapterAnswered: this.adapterAnswered }]);
  }
}

function createTestRoutes() {
  const discovery = new FakeDiscovery();
  return { routes: createExternalAgentRoutes({ discovery }), discovery };
}

async function agentsIn(response: Response): Promise<readonly ExternalAgentDescriptor[]> {
  const payload = (await response.json()) as ExternalAgentDescriptorListResponse;
  return payload.agents;
}

describe('external agent discovery routes', () => {
  it('answers for the hub machine when no environment is named', async () => {
    const { routes, discovery } = createTestRoutes();
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, routes);
    restoreAuth = restore;

    const response = await app.handle(new Request('http://localhost/external-agents'));
    const payload = (await response.json()) as ExternalAgentDescriptorListResponse;

    expect(response.status).toBe(200);
    expect(Value.Check(ExternalAgentDescriptorListResponseSchema, payload)).toBe(true);
    expect(payload.environmentId).toBe('local');
    expect(discovery.scopes).toEqual([{ userId: TEST_USER.id, environmentId: 'local' }]);
  });

  it('asks about the environment the caller named, on the caller’s own behalf', async () => {
    const { routes, discovery } = createTestRoutes();
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, routes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/external-agents?environmentId=env-7')
    );
    const payload = (await response.json()) as ExternalAgentDescriptorListResponse;

    expect(response.status).toBe(200);
    expect(payload.environmentId).toBe('env-7');
    expect(discovery.scopes).toEqual([{ userId: TEST_USER.id, environmentId: 'env-7' }]);
  });

  it('renders the selector without waiting for a vendor subprocess', async () => {
    const { routes, discovery } = createTestRoutes();
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, routes);
    restoreAuth = restore;

    await app.handle(new Request('http://localhost/external-agents'));

    expect(discovery.waited).toEqual([false]);
  });

  it('tells an unauthenticated caller nothing about any machine', async () => {
    const { routes, discovery } = createTestRoutes();
    const app = createApiTestApp(routes);

    const response = await app.handle(new Request('http://localhost/external-agents'));

    expect(response.status).toBe(401);
    expect(discovery.scopes).toEqual([]);
  });
});

/**
 * The reprompt loop, as a route-level test.
 *
 * A cold discovery cache — a reload, a sign-in, a runtime reconnect — serves the
 * cheap pass, whose capability set is a placeholder rather than a finding. When
 * the gate fingerprinted that placeholder, an acknowledgement recorded from a
 * real adapter answer could never match it, so the notice came back on every
 * refresh for consent nobody had withdrawn.
 */
describe('external agent disclosure routes', () => {
  async function signedInApp() {
    const user = await insertTestUser();
    const { routes, discovery } = createTestRoutes();
    const { app, restore } = createAuthenticatedApiTestApp(
      { id: user.id, name: user.name, email: user.email },
      routes
    );
    restoreAuth = restore;
    return { app, discovery };
  }

  function acknowledge(app: {
    handle: (request: Request) => Promise<Response>;
  }): Promise<Response> {
    return app.handle(
      new Request('http://localhost/external-agents/codex/disclosure', { method: 'POST' })
    );
  }

  it('keeps a vendor acknowledged when a later list falls back to the cheap pass', async () => {
    const { app, discovery } = await signedInApp();

    discovery.adapterAnswered = true;
    expect((await acknowledge(app)).status).toBe(200);

    const warm = await agentsIn(await app.handle(new Request('http://localhost/external-agents')));
    expect(warm[0]?.unavailableReason).toBeUndefined();

    discovery.adapterAnswered = false;
    const cold = await agentsIn(await app.handle(new Request('http://localhost/external-agents')));
    expect(cold[0]?.unavailableReason).toBeUndefined();
  });

  it('still asks a user who has never acknowledged, even on the cheap pass', async () => {
    const { app, discovery } = await signedInApp();

    discovery.adapterAnswered = false;
    const agents = await agentsIn(
      await app.handle(new Request('http://localhost/external-agents'))
    );

    expect(agents[0]?.unavailableReason).toBe('disclosure-required');
  });

  it('waits for the adapter before recording an acknowledgement', async () => {
    const { app, discovery } = await signedInApp();

    discovery.adapterAnswered = true;
    await acknowledge(app);

    expect(discovery.waited).toEqual([true]);
  });

  it('refuses to record consent to a capability set nobody answered for', async () => {
    const { app, discovery } = await signedInApp();

    discovery.adapterAnswered = false;
    const response = await acknowledge(app);
    expect(response.status).toBe(503);

    // Nothing was stored, so the notice is still the only way through.
    discovery.adapterAnswered = true;
    const agents = await agentsIn(
      await app.handle(new Request('http://localhost/external-agents'))
    );
    expect(agents[0]?.unavailableReason).toBe('disclosure-required');
  });
});
