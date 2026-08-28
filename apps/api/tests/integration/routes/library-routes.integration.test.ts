import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeRemoteError } from '@mangostudio/runtime';
import { DEFAULT_APP_SETTINGS, withLibraryLocations } from '@mangostudio/shared/app-settings';
import { ERROR_CODES } from '@mangostudio/shared/errors';
import type {
  LibraryResource,
  LibraryResourceContent,
  LibraryScanResult,
  LibraryTargetDescriptor,
  LibraryUnreadableEntry,
} from '@mangostudio/shared/library';
import { listLibraryTargetDescriptors } from '@mangostudio/shared/library/host';
import { DEFAULT_PROFILE_ID } from '@mangostudio/shared/profiles';
import { getDb } from '../../../src/db/database';
import { discoverLibraryResources } from '../../../src/modules/library/application/library-discovery';
import { LibraryFeatureUnavailableError } from '../../../src/modules/library/domain/library-feature-error';
import {
  createLibraryRoutes,
  type LibraryRouteService,
  MAX_LIBRARY_CONTENT_BYTES,
  STATE_REQUIRES_TARGET_MESSAGE,
} from '../../../src/modules/library/http/library-routes';
import { LibraryCache } from '../../../src/modules/library/infrastructure/library-cache';
import { createLibraryPathEnv } from '../../../src/modules/library/infrastructure/location-probe';
import { createAuthenticatedApiTestApp } from '../../support/harness/create-api-test-app';

const TEST_USER = {
  id: 'library-routes-user',
  name: 'Library Routes User',
  email: 'library-routes@mangostudio.test',
};

const skillResource: LibraryResource = {
  ref: { kind: 'skill', slug: 'gh' },
  key: 'skill:gh',
  instances: [
    {
      locationId: 'agents-skills',
      path: '/home/test/.agents/skills/gh',
      modifiedAtMs: 1,
      format: 'markdown-frontmatter',
      title: 'gh',
      description: 'GitHub workflows',
      valid: true,
      contentHash: 'hash',
      sizeBytes: 10,
    },
  ],
  coverage: [
    {
      targetId: 'mangostudio',
      state: 'present',
      effectiveLocationId: 'agents-skills',
      shadowedLocationIds: [],
    },
    {
      targetId: 'claude',
      state: 'absent',
      shadowedLocationIds: [],
    },
    {
      targetId: 'codex',
      state: 'present',
      effectiveLocationId: 'agents-skills',
      shadowedLocationIds: [],
    },
    {
      targetId: 'cursor',
      state: 'absent',
      shadowedLocationIds: [],
    },
  ],
  divergence: 'single',
  whitespaceOnlyDivergence: false,
  contentGroups: [
    {
      contentHash: 'hash',
      locationIds: ['agents-skills'],
      instanceCount: 1,
    },
  ],
};

let restoreAuth: (() => void) | null = null;

afterEach(() => {
  restoreAuth?.();
  restoreAuth = null;
});

function createService(
  resources: LibraryResource[] = [skillResource],
  unreadableEntries: LibraryUnreadableEntry[] = []
) {
  const forced: boolean[] = [];
  const environmentIds: (string | undefined)[] = [];
  const content: LibraryResourceContent = {
    key: 'skill:gh',
    locationId: 'agents-skills',
    content: '# Skill',
    truncated: false,
    sizeBytes: 7,
  };
  const workspaceRoots: (string | undefined)[] = [];
  const service: LibraryRouteService = {
    discover(_userId, force, workspaceRoot, environmentId) {
      forced.push(force);
      workspaceRoots.push(workspaceRoot);
      environmentIds.push(environmentId);
      return Promise.resolve({ resources, unreadableEntries });
    },
    listLocations(_userId, workspaceRoot, environmentId) {
      workspaceRoots.push(workspaceRoot);
      environmentIds.push(environmentId);
      return Promise.resolve([]);
    },
    listTargets: () => [],
    readContent(_userId, _resource, _locationId, workspaceRoot, environmentId) {
      workspaceRoots.push(workspaceRoot);
      environmentIds.push(environmentId);
      return Promise.resolve(content);
    },
  };
  return { service, forced, workspaceRoots, environmentIds };
}

describe('library routes', () => {
  it('filters resources by kind, target, location, and coverage state', async () => {
    const { service } = createService();
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, createLibraryRoutes(service));
    restoreAuth = restore;

    const response = await app.handle(
      new Request(
        'http://localhost/library/resources?kind=skill&target=codex&location=agents-skills&state=present'
      )
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ resources: [skillResource], unreadableEntries: [] });
  });

  it('narrows coverage against the named target rather than any target', async () => {
    const { service } = createService();
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, createLibraryRoutes(service));
    restoreAuth = restore;

    // `claude` is absent from this resource and `codex` has it. Before the
    // filter required a target, `state=absent` matched on `claude`'s coverage
    // and returned the row for every question anyone asked.
    const claude = await app.handle(
      new Request('http://localhost/library/resources?target=claude&state=absent')
    );
    const codex = await app.handle(
      new Request('http://localhost/library/resources?target=codex&state=absent')
    );

    expect(await claude.json()).toEqual({ resources: [skillResource], unreadableEntries: [] });
    expect(await codex.json()).toEqual({ resources: [], unreadableEntries: [] });
  });

  it('rejects state without target with a 400 naming the fix', async () => {
    const { service } = createService();
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, createLibraryRoutes(service));
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/library/resources?state=absent')
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: STATE_REQUIRES_TARGET_MESSAGE,
      code: ERROR_CODES.VALIDATION,
    });
  });

  it('leaves the whole scan unfiltered when no coverage filter is given', async () => {
    const { service } = createService();
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, createLibraryRoutes(service));
    restoreAuth = restore;

    const response = await app.handle(new Request('http://localhost/library/resources'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ resources: [skillResource], unreadableEntries: [] });
  });

  it('reports an entry that fails the library-wide slug pattern without dropping it', async () => {
    const unreadableEntry: LibraryUnreadableEntry = {
      locationId: 'agents-skills',
      name: 'my skill',
      reason: 'invalid-name',
    };
    const { service } = createService([skillResource], [unreadableEntry]);
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, createLibraryRoutes(service));
    restoreAuth = restore;

    const response = await app.handle(new Request('http://localhost/library/resources'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      resources: [skillResource],
      unreadableEntries: [unreadableEntry],
    });
  });

  it('keeps unreadable entries out of the coverage filters and inside the scan filters', async () => {
    const unreadableEntry: LibraryUnreadableEntry = {
      locationId: 'agents-skills',
      name: 'my skill',
      reason: 'invalid-name',
    };
    const { service } = createService([skillResource], [unreadableEntry]);
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, createLibraryRoutes(service));
    restoreAuth = restore;

    // An entry that could not be named as a resource has no coverage, so no
    // target has a state for it. Dropping it under a coverage filter would hide
    // the very names this channel exists to report.
    const absentTarget = await app.handle(
      new Request('http://localhost/library/resources?target=claude&state=absent')
    );
    const presentTarget = await app.handle(
      new Request('http://localhost/library/resources?target=codex')
    );
    // `kind` and `location` describe where a scan looked, so they do apply.
    const otherLocation = await app.handle(
      new Request('http://localhost/library/resources?location=claude-skills')
    );

    const entriesOf = async (response: Response) =>
      ((await response.json()) as LibraryScanResult).unreadableEntries;

    expect(await entriesOf(absentTarget)).toEqual([unreadableEntry]);
    expect(await entriesOf(presentTarget)).toEqual([unreadableEntry]);
    expect(await entriesOf(otherLocation)).toEqual([]);
  });

  it('returns detail and bounded content by validated resource key and location', async () => {
    const { service } = createService();
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, createLibraryRoutes(service));
    restoreAuth = restore;

    const detail = await app.handle(new Request('http://localhost/library/resources/skill:gh'));
    const content = await app.handle(
      new Request('http://localhost/library/resources/skill:gh/content?location=agents-skills')
    );

    expect(detail.status).toBe(200);
    expect(await detail.json()).toEqual(skillResource);
    expect(content.status).toBe(200);
    expect(await content.json()).toMatchObject({
      content: '# Skill',
      truncated: false,
    });
    expect(MAX_LIBRARY_CONTENT_BYTES).toBe(512 * 1024);
  });

  it('rejects malformed keys before resource lookup', async () => {
    const { service, forced } = createService();
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, createLibraryRoutes(service));
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/library/resources/not-a-resource-key')
    );

    expect(response.status).toBe(400);
    expect(forced).toEqual([]);
  });

  it('forces both cache levels through the rescan route', async () => {
    const { service, forced } = createService();
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, createLibraryRoutes(service));
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/library/rescan?force=true', { method: 'POST' })
    );

    expect(response.status).toBe(200);
    expect(forced).toEqual([true]);
  });

  it('returns location health from the registry service', async () => {
    const { service } = createService();
    const locations = [
      {
        id: 'agents-skills' as const,
        kind: 'skill' as const,
        scope: 'home' as const,
        path: '/home/test/.agents/skills',
        access: 'read-write' as const,
        exists: true,
        readable: true,
        writable: true,
        targetIds: ['mangostudio' as const, 'codex' as const],
        entryCount: 1,
      },
    ];
    service.listLocations = () => Promise.resolve(locations);
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, createLibraryRoutes(service));
    restoreAuth = restore;

    const response = await app.handle(new Request('http://localhost/library/locations'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(locations);
  });

  it('accepts a valid workspace root and answers exactly as it does without one', async () => {
    const { service, workspaceRoots } = createService();
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, createLibraryRoutes(service));
    restoreAuth = restore;

    const plain = await app.handle(new Request('http://localhost/library/resources'));
    const scoped = await app.handle(
      new Request(
        `http://localhost/library/resources?workspaceRoot=${encodeURIComponent(process.cwd())}`
      )
    );

    expect(plain.status).toBe(200);
    expect(scoped.status).toBe(200);
    // The seam is inert in v1: no location resolves under a workspace root, so
    // the parameter is carried to the scanner and changes nothing.
    expect(await scoped.json()).toEqual(await plain.json());
    expect(workspaceRoots).toEqual([undefined, process.cwd()]);
  });

  it('rejects a workspace root that is not a usable directory', async () => {
    const { service, workspaceRoots } = createService();
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, createLibraryRoutes(service));
    restoreAuth = restore;

    const missing = await app.handle(
      new Request('http://localhost/library/locations?workspaceRoot=/nonexistent-workspace-root')
    );
    const notADirectory = await app.handle(
      new Request(
        `http://localhost/library/resources?workspaceRoot=${encodeURIComponent(
          join(process.cwd(), 'package.json')
        )}`
      )
    );

    expect(missing.status).toBe(422);
    expect(await missing.json()).toMatchObject({ code: 'VALIDATION' });
    expect(notADirectory.status).toBe(422);
    // A rejected root never reaches the scanner.
    expect(workspaceRoots).toEqual([]);
  });

  it('rejects a relative workspace root rather than resolving it against the server cwd', async () => {
    const { service, workspaceRoots } = createService();
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, createLibraryRoutes(service));
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/library/locations?workspaceRoot=.')
    );

    expect(response.status).toBe(422);
    expect(workspaceRoots).toEqual([]);
  });

  it('serves the target registry so a filtered matrix keeps every column', async () => {
    const { service } = createService();
    const { app, restore } = createAuthenticatedApiTestApp(
      TEST_USER,
      // The default service is the real registry: the route exists so the
      // client never has to restate the target list or its read precedence.
      createLibraryRoutes({ ...service, listTargets: listLibraryTargetDescriptors })
    );
    restoreAuth = restore;

    const response = await app.handle(new Request('http://localhost/library/targets'));

    expect(response.status).toBe(200);
    const targets = (await response.json()) as LibraryTargetDescriptor[];
    expect(targets.map((target) => target.id)).toEqual([
      'mangostudio',
      'claude',
      'codex',
      'cursor',
    ]);
    // A skill in `agents-skills` covers MangoStudio and Codex from one write,
    // and that fact is only derivable from the per-kind read precedence.
    expect(targets.find((target) => target.id === 'codex')?.reads.skill).toContain('agents-skills');
  });

  it('forwards environmentId on resources, content, locations, and rescan', async () => {
    const { service, environmentIds } = createService();
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, createLibraryRoutes(service));
    restoreAuth = restore;

    const env = 'remote-box';
    const resources = await app.handle(
      new Request(`http://localhost/library/resources?environmentId=${env}`)
    );
    const detail = await app.handle(
      new Request(`http://localhost/library/resources/skill:gh?environmentId=${env}`)
    );
    const content = await app.handle(
      new Request(
        `http://localhost/library/resources/skill:gh/content?location=agents-skills&environmentId=${env}`
      )
    );
    const locations = await app.handle(
      new Request(`http://localhost/library/locations?environmentId=${env}`)
    );
    const rescan = await app.handle(
      new Request(`http://localhost/library/rescan?force=true&environmentId=${env}`, {
        method: 'POST',
      })
    );

    expect(resources.status).toBe(200);
    expect(detail.status).toBe(200);
    expect(content.status).toBe(200);
    expect(locations.status).toBe(200);
    expect(rescan.status).toBe(200);
    // resources + detail discover + content discover + content read + locations + rescan
    expect(environmentIds).toEqual([env, env, env, env, env, env]);
  });

  it('maps a missing library feature to 422', async () => {
    const { service } = createService();
    service.discover = () =>
      Promise.reject(
        new LibraryFeatureUnavailableError(
          'Environment "remote-box" does not advertise library discovery.'
        )
      );
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, createLibraryRoutes(service));
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/library/resources?environmentId=remote-box')
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      code: 'VALIDATION',
      error: 'Environment "remote-box" does not advertise library discovery.',
    });
  });

  it('maps an unreachable environment to 503 rather than a server fault', async () => {
    const { service } = createService();
    service.discover = () =>
      Promise.reject(
        new RuntimeRemoteError('RUNTIME_UNAVAILABLE', 'Environment "remote-box" was not found.')
      );
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, createLibraryRoutes(service));
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/library/resources?environmentId=remote-box')
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: 'PROVIDER_ERROR',
      error: 'Environment "remote-box" was not found.',
    });
  });

  it('maps a denied content read to 404', async () => {
    const { service } = createService();
    service.readContent = () => Promise.resolve(null);
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, createLibraryRoutes(service));
    restoreAuth = restore;

    const response = await app.handle(
      new Request(
        'http://localhost/library/resources/skill:gh/content?location=agents-skills&environmentId=remote-box'
      )
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: 'NOT_FOUND' });
  });
});

/**
 * `command` locations are home-scoped and disabled by default
 * (`DEFAULT_LIBRARY_LOCATION_SETTINGS` only turns on the two mango ones), so
 * every test here enables `claude-commands`/`codex-prompts` explicitly and
 * scans a real temp home instead of a scripted `LibraryRouteService` — the
 * only way to prove the route wires kind filtering, coverage, divergence, and
 * the unreadable-entries channel through to a real discovery scan.
 */
describe('library routes over real command locations', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mango-command-routes-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    restoreAuth?.();
    restoreAuth = null;
  });

  function claudeCommandsDir(): string {
    return join(home, '.claude', 'commands');
  }

  function codexPromptsDir(): string {
    return join(home, '.codex', 'prompts');
  }

  function writeClaudeCommand(fileName: string, body: string): void {
    mkdirSync(claudeCommandsDir(), { recursive: true });
    writeFileSync(join(claudeCommandsDir(), fileName), body);
  }

  function writeCodexPrompt(fileName: string, body: string): void {
    mkdirSync(codexPromptsDir(), { recursive: true });
    writeFileSync(join(codexPromptsDir(), fileName), body);
  }

  function realCommandRouteService(): LibraryRouteService {
    const pathEnv = createLibraryPathEnv({ homeDir: home, env: {} });
    const settings = withLibraryLocations(DEFAULT_APP_SETTINGS, DEFAULT_PROFILE_ID, {
      home: { 'claude-commands': true, 'codex-prompts': true },
      workspace: {},
    });
    return {
      discover: (userId) =>
        discoverLibraryResources(getDb(), userId, {
          force: true,
          kinds: ['command'],
          cache: new LibraryCache(),
          pathEnv,
          settings,
        }),
      listLocations: () => Promise.resolve([]),
      listTargets: listLibraryTargetDescriptors,
      readContent: () => Promise.resolve(null),
    };
  }

  function commandResourceOf(scan: LibraryScanResult, key: string): LibraryResource {
    const resource = scan.resources.find((candidate) => candidate.key === key);
    if (!resource) throw new Error(`Expected "${key}" in the scan.`);
    return resource;
  }

  it('discovers a claude command and covers claude alone', async () => {
    writeClaudeCommand('deploy.md', '---\ndescription: Deploy the app\n---\nDeploy steps.\n');
    const { app, restore } = createAuthenticatedApiTestApp(
      TEST_USER,
      createLibraryRoutes(realCommandRouteService())
    );
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/library/resources?kind=command')
    );

    expect(response.status).toBe(200);
    const scan = (await response.json()) as LibraryScanResult;
    const resource = commandResourceOf(scan, 'command:deploy');
    expect(resource.ref).toEqual({ kind: 'command', slug: 'deploy' });
    expect(resource.coverage).toEqual([
      { targetId: 'mangostudio', state: 'absent', shadowedLocationIds: [] },
      {
        targetId: 'claude',
        state: 'present',
        effectiveLocationId: 'claude-commands',
        shadowedLocationIds: [],
      },
      { targetId: 'codex', state: 'absent', shadowedLocationIds: [] },
      { targetId: 'cursor', state: 'absent', shadowedLocationIds: [] },
    ]);
  });

  it('reports uniform divergence for byte-identical copies across vendors', async () => {
    const body = '---\ndescription: Deploy the app\n---\nDeploy steps.\n';
    writeClaudeCommand('deploy.md', body);
    writeCodexPrompt('deploy.md', body);
    const { app, restore } = createAuthenticatedApiTestApp(
      TEST_USER,
      createLibraryRoutes(realCommandRouteService())
    );
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/library/resources?kind=command')
    );

    const scan = (await response.json()) as LibraryScanResult;
    expect(commandResourceOf(scan, 'command:deploy').divergence).toBe('uniform');
  });

  it('reports divergent for copies whose bytes differ across vendors', async () => {
    writeClaudeCommand('deploy.md', '---\ndescription: Deploy the app\n---\nDeploy steps.\n');
    writeCodexPrompt('deploy.md', '---\ndescription: Deploy the app\n---\nDifferent steps.\n');
    const { app, restore } = createAuthenticatedApiTestApp(
      TEST_USER,
      createLibraryRoutes(realCommandRouteService())
    );
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/library/resources?kind=command')
    );

    const scan = (await response.json()) as LibraryScanResult;
    expect(commandResourceOf(scan, 'command:deploy').divergence).toBe('divergent');
  });

  it('reports a command whose stem fails the slug pattern on the unreadable-entries channel', async () => {
    writeClaudeCommand('deploy.md', '---\ndescription: Deploy the app\n---\nDeploy steps.\n');
    // The space makes "my deploy" fail LIBRARY_RESOURCE_SLUG_PATTERN. Reported
    // by its full file name — directory-of-files locations name unreadable
    // entries with the extension still on, unlike a directory-of-dirs entry.
    writeClaudeCommand('my deploy.md', '---\ndescription: Not nameable\n---\nBody.\n');
    const { app, restore } = createAuthenticatedApiTestApp(
      TEST_USER,
      createLibraryRoutes(realCommandRouteService())
    );
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/library/resources?kind=command')
    );

    const scan = (await response.json()) as LibraryScanResult;
    expect(scan.unreadableEntries).toEqual([
      { locationId: 'claude-commands', name: 'my deploy.md', reason: 'invalid-name' },
    ]);
    expect(scan.resources.map((resource) => resource.key)).toContain('command:deploy');
  });
});
