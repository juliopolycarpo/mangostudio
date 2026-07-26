import { afterEach, describe, expect, it } from 'bun:test';
import {
  type AgentCliStatus,
  AgentCliStatusListSchema,
  AgentCliStatusSchema,
  RuntimeStatusListSchema,
  RuntimeStatusSchema,
  type VersionManagerStatus,
  VersionManagerStatusListSchema,
  VersionManagerStatusSchema,
} from '@mangostudio/shared/environments';
import { Value } from '@sinclair/typebox/value';
import type { AgentCliDetectionService } from '../../../src/modules/environments/application/agent-cli-detection';
import { createRuntimeDetectionService } from '../../../src/modules/environments/application/runtime-detection';
import type { VersionManagerDetectionService } from '../../../src/modules/environments/application/version-manager-detection';
import type { BinaryScanDeps } from '../../../src/modules/environments/domain/binary-scan';
import { NODE_RUNTIME_DEFINITION } from '../../../src/modules/environments/domain/runtime-definitions';
import { createEnvironmentRoutes } from '../../../src/modules/environments/http/environment-routes';
import {
  createApiTestApp,
  createAuthenticatedApiTestApp,
} from '../../support/harness/create-api-test-app';

const TEST_USER = {
  id: 'environments-routes-user',
  name: 'Environments Routes User',
  email: 'environments-routes@mangostudio.test',
};

let restoreAuth: (() => void) | null = null;

afterEach(() => {
  restoreAuth?.();
  restoreAuth = null;
});

function createTestRoutes() {
  let probeCount = 0;
  let versionManagerProbeCount = 0;
  let agentProbeCount = 0;
  let lastAgentForce = false;
  const definition = {
    ...NODE_RUNTIME_DEFINITION,
    wellKnownDirs: () => [],
    includeBareBinaryNames: false,
  };
  const createDeps = (): BinaryScanDeps => ({
    platform: 'linux',
    homeDir: '/home/tester',
    env: { PATH: '/node/bin' },
    pathExists: () => true,
    probeVersion: () => {
      probeCount += 1;
      return Promise.resolve('v22.13.0');
    },
    realpath: (path) => Promise.resolve(path),
  });
  const service = createRuntimeDetectionService({
    definitions: [definition],
    createDeps,
    now: () => 1_700_000_000_000,
  });
  const versionManagerStatus: VersionManagerStatus = {
    id: 'nvm',
    installed: true,
    root: '/home/tester/.nvm',
    versions: [],
    findings: [],
  };
  const versionManagerService: VersionManagerDetectionService = {
    listVersionManagerStatuses: () => {
      versionManagerProbeCount += 1;
      return Promise.resolve([versionManagerStatus]);
    },
    getVersionManagerStatus: (id) => {
      versionManagerProbeCount += 1;
      return Promise.resolve(id === 'nvm' ? versionManagerStatus : null);
    },
    resetVersionManagerCache: () => undefined,
  };
  const agentStatus: AgentCliStatus = {
    id: 'claude',
    targetId: 'claude',
    health: 'ok',
    installations: [
      {
        path: '/agent/bin/claude',
        rawPath: '/agent/bin/claude',
        version: '2.1.220 (Claude Code)',
        origin: 'path',
        pathIndex: 0,
        effective: true,
      },
    ],
    effective: {
      path: '/agent/bin/claude',
      rawPath: '/agent/bin/claude',
      version: '2.1.220 (Claude Code)',
      origin: 'path',
      pathIndex: 0,
      effective: true,
    },
    findings: [],
    installable: false,
    probedAtMs: 1_700_000_000_000,
    configHome: '/home/tester/.claude',
    configHomeExists: true,
    authenticated: true,
    authSignal: 'file-present',
    locations: [],
  };
  const agentService: AgentCliDetectionService = {
    listAgentCliStatuses: (options) => {
      agentProbeCount += 1;
      lastAgentForce = options?.force ?? false;
      return Promise.resolve([agentStatus]);
    },
    getAgentCliStatus: (targetId, options) => {
      agentProbeCount += 1;
      lastAgentForce = options?.force ?? false;
      return Promise.resolve(targetId === 'claude' ? agentStatus : null);
    },
    resetAgentCliCache: () => undefined,
  };

  return {
    routes: createEnvironmentRoutes(service, versionManagerService, agentService),
    getProbeCount: () => probeCount,
    getVersionManagerProbeCount: () => versionManagerProbeCount,
    getAgentProbeCount: () => agentProbeCount,
    getLastAgentForce: () => lastAgentForce,
  };
}

describe('environment runtime routes', () => {
  it('lists, reads, and force-probes authenticated runtime status', async () => {
    const { routes, getProbeCount } = createTestRoutes();
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, routes);
    restoreAuth = restore;

    const list = await app.handle(new Request('http://localhost/environments/runtimes'));
    const listPayload = await list.json();
    const read = await app.handle(new Request('http://localhost/environments/runtimes/node'));
    const readPayload = await read.json();
    const force = await app.handle(
      new Request('http://localhost/environments/runtimes/node/probe', { method: 'POST' })
    );
    const forcePayload = await force.json();

    expect(list.status).toBe(200);
    expect(Value.Check(RuntimeStatusListSchema, listPayload)).toBe(true);
    expect(read.status).toBe(200);
    expect(Value.Check(RuntimeStatusSchema, readPayload)).toBe(true);
    expect(force.status).toBe(200);
    expect(Value.Check(RuntimeStatusSchema, forcePayload)).toBe(true);
    expect(getProbeCount()).toBe(2);
  });

  it('lists, reads, and force-probes authenticated version-manager status', async () => {
    const { routes, getVersionManagerProbeCount } = createTestRoutes();
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, routes);
    restoreAuth = restore;

    const list = await app.handle(new Request('http://localhost/environments/version-managers'));
    const listPayload = await list.json();
    const read = await app.handle(
      new Request('http://localhost/environments/version-managers/nvm')
    );
    const readPayload = await read.json();
    const force = await app.handle(
      new Request('http://localhost/environments/version-managers/nvm/probe', {
        method: 'POST',
      })
    );
    const forcePayload = await force.json();

    expect(list.status).toBe(200);
    expect(Value.Check(VersionManagerStatusListSchema, listPayload)).toBe(true);
    expect(read.status).toBe(200);
    expect(Value.Check(VersionManagerStatusSchema, readPayload)).toBe(true);
    expect(force.status).toBe(200);
    expect(Value.Check(VersionManagerStatusSchema, forcePayload)).toBe(true);
    expect(getVersionManagerProbeCount()).toBe(3);
  });

  it('lists, reads, and force-probes authenticated agent CLI status', async () => {
    const { routes, getAgentProbeCount, getLastAgentForce } = createTestRoutes();
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, routes);
    restoreAuth = restore;

    const list = await app.handle(new Request('http://localhost/environments/agents'));
    const listPayload = await list.json();
    const read = await app.handle(new Request('http://localhost/environments/agents/claude'));
    const readPayload = await read.json();
    const force = await app.handle(
      new Request('http://localhost/environments/agents/claude/probe', {
        method: 'POST',
      })
    );
    const forcePayload = await force.json();

    expect(list.status).toBe(200);
    expect(Value.Check(AgentCliStatusListSchema, listPayload)).toBe(true);
    expect(read.status).toBe(200);
    expect(Value.Check(AgentCliStatusSchema, readPayload)).toBe(true);
    expect(force.status).toBe(200);
    expect(Value.Check(AgentCliStatusSchema, forcePayload)).toBe(true);
    expect(getAgentProbeCount()).toBe(3);
    expect(getLastAgentForce()).toBe(true);
  });

  it('rejects unsupported ids before any runtime probe', async () => {
    const { routes, getProbeCount, getVersionManagerProbeCount, getAgentProbeCount } =
      createTestRoutes();
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, routes);
    restoreAuth = restore;

    const invalid = await app.handle(new Request('http://localhost/environments/runtimes/python'));
    const notImplemented = await app.handle(
      new Request('http://localhost/environments/runtimes/nvm')
    );
    const invalidManager = await app.handle(
      new Request('http://localhost/environments/version-managers/asdf')
    );
    const reservedManager = await app.handle(
      new Request('http://localhost/environments/version-managers/fnm')
    );
    const invalidAgent = await app.handle(
      new Request('http://localhost/environments/agents/unknown')
    );

    expect(invalid.status).toBe(422);
    expect(notImplemented.status).toBe(404);
    expect(invalidManager.status).toBe(422);
    expect(reservedManager.status).toBe(404);
    expect(invalidAgent.status).toBe(422);
    expect(getProbeCount()).toBe(0);
    expect(getVersionManagerProbeCount()).toBe(1);
    expect(getAgentProbeCount()).toBe(0);
  });

  it('requires authentication for every runtime route', async () => {
    const { routes, getProbeCount, getVersionManagerProbeCount, getAgentProbeCount } =
      createTestRoutes();
    const app = createApiTestApp(routes);

    const list = await app.handle(new Request('http://localhost/environments/runtimes'));
    const read = await app.handle(new Request('http://localhost/environments/runtimes/node'));
    const force = await app.handle(
      new Request('http://localhost/environments/runtimes/node/probe', { method: 'POST' })
    );
    const managers = await app.handle(
      new Request('http://localhost/environments/version-managers')
    );
    const manager = await app.handle(
      new Request('http://localhost/environments/version-managers/nvm')
    );
    const managerForce = await app.handle(
      new Request('http://localhost/environments/version-managers/nvm/probe', {
        method: 'POST',
      })
    );
    const agents = await app.handle(new Request('http://localhost/environments/agents'));
    const agent = await app.handle(new Request('http://localhost/environments/agents/claude'));
    const agentForce = await app.handle(
      new Request('http://localhost/environments/agents/claude/probe', {
        method: 'POST',
      })
    );

    expect([
      list.status,
      read.status,
      force.status,
      managers.status,
      manager.status,
      managerForce.status,
      agents.status,
      agent.status,
      agentForce.status,
    ]).toEqual([401, 401, 401, 401, 401, 401, 401, 401, 401]);
    expect(getProbeCount()).toBe(0);
    expect(getVersionManagerProbeCount()).toBe(0);
    expect(getAgentProbeCount()).toBe(0);
  });
});
