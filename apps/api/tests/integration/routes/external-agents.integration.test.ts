import { afterEach, describe, expect, it } from 'bun:test';

import { ERROR_CODES } from '@mangostudio/shared/errors';
import type {
  ExternalAgentCapabilities,
  ExternalAgentCommandCatalogResponse,
  ExternalAgentDescriptor,
  ExternalAgentDescriptorListResponse,
  ExternalSupportedConfiguration,
  ExternalWorkspaceTrustListResponse,
} from '@mangostudio/shared/external-agents';
import {
  EXTERNAL_WORKSPACE_TRUST_VERSION,
  ExternalAgentDescriptorListResponseSchema,
  ExternalWorkspaceTrustListResponseSchema,
  NO_EXTERNAL_AGENT_CAPABILITIES,
} from '@mangostudio/shared/external-agents';
import Value from 'typebox/value';

import { getDb } from '../../../src/db/database';
import type { ProbeScope } from '../../../src/modules/environments/application/probing-service';
import type {
  DescribeExternalAgentsOptions,
  DiscoveredExternalAgent,
  ExternalAgentDiscoveryService,
} from '../../../src/modules/external-agents/application/external-agent-discovery';
import { createExternalCommandCatalogCache } from '../../../src/modules/external-agents/application/external-command-catalog-cache';
import {
  grantWorkspaceTrust,
  requiresWorkspaceTrust,
} from '../../../src/modules/external-agents/application/external-workspace-trust';
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
  /** What an answering adapter reports: a real matrix, or none, as the runtime does for a CLI it could not start. */
  answer: Partial<ExternalAgentDescriptor> = {
    capabilities: ADAPTER_CAPABILITIES,
    supportedConfigurations: ADAPTER_CONFIGURATIONS,
  };

  describeExternalAgents(
    scope: ProbeScope,
    options: DescribeExternalAgentsOptions = {}
  ): Promise<readonly DiscoveredExternalAgent[]> {
    this.scopes.push(scope);
    this.waited.push(options.waitForAdapter === true);
    const descriptor = this.adapterAnswered
      ? descriptorFor(scope.environmentId, this.answer)
      : descriptorFor(scope.environmentId);
    return Promise.resolve([{ descriptor, adapterAnswered: this.adapterAnswered }]);
  }
}

function createTestRoutes() {
  const discovery = new FakeDiscovery();
  return { routes: createExternalAgentRoutes({ discovery }), discovery };
}

function createTestRoutesWithCatalog() {
  const discovery = new FakeDiscovery();
  const commandCatalog = createExternalCommandCatalogCache();
  return {
    routes: createExternalAgentRoutes({ discovery, commandCatalog }),
    discovery,
    commandCatalog,
  };
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

  /**
   * The remedy travels with the reason, always.
   *
   * `ExternalAgentDescriptor` says `remedy` is absent exactly when
   * `unavailableReason` is, and this route stamps a reason onto a descriptor
   * that was built without one — so it owes the matching remedy too. Without it
   * the one row whose fix is a dialog this app already owns arrives with
   * nothing to offer.
   */
  it('carries the remedy for the reason it stamps on', async () => {
    const { app, discovery } = await signedInApp();

    discovery.adapterAnswered = false;
    const agents = await agentsIn(
      await app.handle(new Request('http://localhost/external-agents'))
    );

    expect(agents[0]?.remedy).toEqual({ kind: 'accept-disclosure' });
  });

  it('waits for the adapter before recording an acknowledgement', async () => {
    const { app, discovery } = await signedInApp();

    discovery.adapterAnswered = true;
    await acknowledge(app);

    expect(discovery.waited).toEqual([true]);
  });

  it('refuses to record consent over a CLI the operating system refused to start', async () => {
    const { app, discovery } = await signedInApp();

    // What the hub builds from the runtime's answer for a CLI it found but could not start.
    discovery.adapterAnswered = true;
    discovery.answer = {
      discoveryState: 'determined',
      supportedConfigurations: [],
      unavailableReason: 'launch-refused',
      remedy: { kind: 'none' },
    };
    const response = await acknowledge(app);
    expect(response.status).toBe(404);

    // The row keeps its own reason instead of being stamped `disclosure-required`: the notice is
    // unreachable until the CLI starts, so the selector must not offer it.
    const refused = await agentsIn(
      await app.handle(new Request('http://localhost/external-agents'))
    );
    expect(refused[0]?.unavailableReason).toBe('launch-refused');

    // Nothing was stored: once the CLI starts and the adapter reports a matrix, the
    // notice is still owed.
    discovery.answer = {
      capabilities: ADAPTER_CAPABILITIES,
      supportedConfigurations: ADAPTER_CONFIGURATIONS,
    };
    const agents = await agentsIn(
      await app.handle(new Request('http://localhost/external-agents'))
    );
    expect(agents[0]?.unavailableReason).toBe('disclosure-required');
  });

  it('records consent over an undetermined answer that carries a matrix', async () => {
    const { app, discovery } = await signedInApp();

    discovery.adapterAnswered = true;
    discovery.answer = {
      discoveryState: 'undetermined',
      capabilities: ADAPTER_CAPABILITIES,
      supportedConfigurations: ADAPTER_CONFIGURATIONS,
    };

    expect((await acknowledge(app)).status).toBe(200);
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

/**
 * A reload's last resort before this chat's own first turn re-announces a
 * catalog: whatever a turn against this (user, environment, target) wrote
 * most recently, even one from a different chat.
 */
describe('external agent command catalog route', () => {
  it('answers empty for a target nothing has ever announced', async () => {
    const { routes } = createTestRoutesWithCatalog();
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, routes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/external-agents/claude/commands')
    );
    const payload = (await response.json()) as ExternalAgentCommandCatalogResponse;

    expect(response.status).toBe(200);
    expect(payload.commands).toEqual([]);
  });

  it('returns the last catalog written for that user, environment and target', async () => {
    const { routes, commandCatalog } = createTestRoutesWithCatalog();
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, routes);
    restoreAuth = restore;

    commandCatalog.write({ userId: TEST_USER.id, environmentId: 'local', targetId: 'claude' }, [
      { name: 'review' },
      { name: 'dataviz', description: 'Draws charts' },
    ]);

    const response = await app.handle(
      new Request('http://localhost/external-agents/claude/commands')
    );
    const payload = (await response.json()) as ExternalAgentCommandCatalogResponse;

    expect(payload.commands).toEqual([
      { name: 'review' },
      { name: 'dataviz', description: 'Draws charts' },
    ]);
  });

  it('keys by environment, so a different one is not served this one’s hint', async () => {
    const { routes, commandCatalog } = createTestRoutesWithCatalog();
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, routes);
    restoreAuth = restore;

    commandCatalog.write({ userId: TEST_USER.id, environmentId: 'env-7', targetId: 'claude' }, [
      { name: 'review' },
    ]);

    const response = await app.handle(
      new Request('http://localhost/external-agents/claude/commands')
    );
    const payload = (await response.json()) as ExternalAgentCommandCatalogResponse;

    expect(payload.commands).toEqual([]);
  });

  it('rejects a target that is not a real vendor', async () => {
    const { routes } = createTestRoutesWithCatalog();
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, routes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/external-agents/not-a-vendor/commands')
    );

    expect(response.status).toBe(404);
  });

  it('tells an unauthenticated caller nothing', async () => {
    const { routes } = createTestRoutesWithCatalog();
    const app = createApiTestApp(routes);

    const response = await app.handle(
      new Request('http://localhost/external-agents/claude/commands')
    );

    expect(response.status).toBe(401);
  });
});

/**
 * Withdrawing a workspace-trust grant.
 *
 * Grants live in each user's own settings row, so the cases that matter are the
 * ones that could reach past it: another user's grant for the same folder, a
 * spelling of the path that was never stored, and the next turn's gate.
 */
describe('external agent workspace-trust routes', () => {
  const CURSOR_REPO = {
    targetId: 'cursor',
    environmentId: 'local',
    workspacePath: '/canonical/work/repo',
  } as const;

  async function userApp() {
    const user = await insertTestUser();
    const { routes } = createTestRoutes();
    const { app, restore } = createAuthenticatedApiTestApp(
      { id: user.id, name: user.name, email: user.email },
      routes
    );
    restoreAuth = restore;
    return { app, userId: user.id };
  }

  function revoke(
    app: { handle: (request: Request) => Promise<Response> },
    body: unknown
  ): Promise<Response> {
    return app.handle(
      new Request('http://localhost/external-agents/workspace-trust', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    );
  }

  async function listGrants(app: { handle: (request: Request) => Promise<Response> }) {
    const response = await app.handle(
      new Request('http://localhost/external-agents/workspace-trust')
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as ExternalWorkspaceTrustListResponse;
    expect(Value.Check(ExternalWorkspaceTrustListResponseSchema, payload)).toBe(true);
    return payload.grants;
  }

  it('lists the caller’s grants and nobody else’s', async () => {
    const { app, userId } = await userApp();
    const other = await insertTestUser();
    await grantWorkspaceTrust({ userId, ...CURSOR_REPO }, getDb(), () => 1_000);
    await grantWorkspaceTrust(
      { userId: other.id, ...CURSOR_REPO, workspacePath: '/canonical/other/secret' },
      getDb(),
      () => 2_000
    );

    expect(await listGrants(app)).toEqual([
      {
        ...CURSOR_REPO,
        version: EXTERNAL_WORKSPACE_TRUST_VERSION,
        acceptedAt: 1_000,
      },
    ]);
  });

  it('revokes the grant, so the next turn asks for trust again', async () => {
    const { app, userId } = await userApp();
    const scope = { userId, ...CURSOR_REPO };
    await grantWorkspaceTrust(scope, getDb());
    expect(await requiresWorkspaceTrust(scope, getDb())).toBe(false);

    const response = await revoke(app, CURSOR_REPO);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ revoked: true });
    expect(await requiresWorkspaceTrust(scope, getDb())).toBe(true);
    expect(await listGrants(app)).toEqual([]);
  });

  it('leaves the caller’s other grants and every other user’s grant untouched', async () => {
    const { app, userId } = await userApp();
    const other = await insertTestUser();
    const sibling = { userId, ...CURSOR_REPO, workspacePath: '/canonical/work/repo/packages' };
    const otherEnvironment = { userId, ...CURSOR_REPO, environmentId: 'build-server' };
    const othersGrant = { userId: other.id, ...CURSOR_REPO };
    for (const scope of [{ userId, ...CURSOR_REPO }, sibling, otherEnvironment, othersGrant]) {
      await grantWorkspaceTrust(scope, getDb());
    }

    expect((await revoke(app, CURSOR_REPO)).status).toBe(200);

    // A parent folder's key never matches a child's, nor one machine's another's.
    expect(await requiresWorkspaceTrust(sibling, getDb())).toBe(false);
    expect(await requiresWorkspaceTrust(otherEnvironment, getDb())).toBe(false);
    expect(await requiresWorkspaceTrust(othersGrant, getDb())).toBe(false);
    expect(await requiresWorkspaceTrust({ userId, ...CURSOR_REPO }, getDb())).toBe(true);
  });

  it('answers 404 for a grant the caller never gave, even when another user did', async () => {
    const { app, userId } = await userApp();
    const other = await insertTestUser();
    const othersGrant = { userId: other.id, ...CURSOR_REPO };
    await grantWorkspaceTrust(othersGrant, getDb());

    const response = await revoke(app, CURSOR_REPO);

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: ERROR_CODES.NOT_FOUND });
    expect(await requiresWorkspaceTrust(othersGrant, getDb())).toBe(false);
    expect(await requiresWorkspaceTrust({ userId, ...CURSOR_REPO }, getDb())).toBe(true);
  });

  it('matches the stored path literally instead of re-spelling it', async () => {
    const { app, userId } = await userApp();
    const scope = { userId, ...CURSOR_REPO };
    await grantWorkspaceTrust(scope, getDb());

    const response = await revoke(app, {
      ...CURSOR_REPO,
      workspacePath: `${CURSOR_REPO.workspacePath}/`,
    });

    expect(response.status).toBe(404);
    expect(await requiresWorkspaceTrust(scope, getDb())).toBe(false);
  });

  it('rejects a body that does not name the whole key', async () => {
    const { app } = await userApp();

    const response = await revoke(app, { targetId: 'cursor', environmentId: 'local' });

    expect(response.status).toBe(422);
  });

  it('tells an unauthenticated caller nothing', async () => {
    const { routes } = createTestRoutes();
    const app = createApiTestApp(routes);

    expect((await revoke(app, CURSOR_REPO)).status).toBe(401);
    expect(
      (await app.handle(new Request('http://localhost/external-agents/workspace-trust'))).status
    ).toBe(401);
  });
});
