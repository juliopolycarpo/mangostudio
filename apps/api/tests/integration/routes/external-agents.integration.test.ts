import { afterEach, describe, expect, it } from 'bun:test';
import type {
  ExternalAgentDescriptor,
  ExternalAgentDescriptorListResponse,
} from '@mangostudio/shared/external-agents';
import {
  ExternalAgentDescriptorListResponseSchema,
  NO_EXTERNAL_AGENT_CAPABILITIES,
} from '@mangostudio/shared/external-agents';
import { Value } from '@sinclair/typebox/value';
import type { ProbeScope } from '../../../src/modules/environments/application/probing-service';
import type { ExternalAgentDiscoveryService } from '../../../src/modules/external-agents/application/external-agent-discovery';
import { createExternalAgentRoutes } from '../../../src/modules/external-agents/http/external-agent-routes';
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

function descriptorFor(environmentId: string): ExternalAgentDescriptor {
  return {
    targetId: 'codex',
    environmentId,
    installed: true,
    version: '0.147.0',
    authState: 'signed-in',
    capabilities: NO_EXTERNAL_AGENT_CAPABILITIES,
    supportedConfigurations: [],
    unavailableReason: 'not-yet-available',
  };
}

function createTestRoutes() {
  const scopes: ProbeScope[] = [];
  const discovery: ExternalAgentDiscoveryService = {
    listExternalAgents: (scope) => {
      scopes.push(scope);
      return Promise.resolve([descriptorFor(scope.environmentId)]);
    },
    resetCache: () => undefined,
  };

  return { routes: createExternalAgentRoutes(discovery), getScopes: () => scopes };
}

describe('external agent discovery routes', () => {
  it('answers for the hub machine when no environment is named', async () => {
    const { routes, getScopes } = createTestRoutes();
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, routes);
    restoreAuth = restore;

    const response = await app.handle(new Request('http://localhost/external-agents'));
    const payload = (await response.json()) as ExternalAgentDescriptorListResponse;

    expect(response.status).toBe(200);
    expect(Value.Check(ExternalAgentDescriptorListResponseSchema, payload)).toBe(true);
    expect(payload.environmentId).toBe('local');
    expect(getScopes()).toEqual([{ userId: TEST_USER.id, environmentId: 'local' }]);
  });

  it('asks about the environment the caller named, on the caller’s own behalf', async () => {
    const { routes, getScopes } = createTestRoutes();
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, routes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/external-agents?environmentId=env-7')
    );
    const payload = (await response.json()) as ExternalAgentDescriptorListResponse;

    expect(response.status).toBe(200);
    expect(payload.environmentId).toBe('env-7');
    expect(getScopes()).toEqual([{ userId: TEST_USER.id, environmentId: 'env-7' }]);
  });

  it('tells an unauthenticated caller nothing about any machine', async () => {
    const { routes, getScopes } = createTestRoutes();
    const app = createApiTestApp(routes);

    const response = await app.handle(new Request('http://localhost/external-agents'));

    expect(response.status).toBe(401);
    expect(getScopes()).toEqual([]);
  });
});
