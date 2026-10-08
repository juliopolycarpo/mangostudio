import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';

import { ROOT_DIR, WORKSPACES } from '../lib/config';
import {
  CHANGED_LANE_DEPENDENCIES,
  type ChangedLane,
  changedTestArg,
  createChangedTurboTestCommands,
  planChangedLanes,
} from '../lib/test';

const ALL_LANES: ChangedLane[] = ['root', 'frontend', 'api', 'shared'];

/** `lane: mode` pairs, so a failure prints which lane got which mode. */
function modes(files: string[], lanes: ChangedLane[] = ALL_LANES): string[] {
  return planChangedLanes(files, lanes).map(({ lane, mode }) => `${lane}: ${mode}`);
}

describe('planChangedLanes', () => {
  // Bun follows the module graph inside one workspace, so a source edit there
  // is exactly what `--changed` is for.
  it('hands --changed to every lane when only a leaf workspace module changed', () => {
    expect(modes(['apps/frontend/src/features/chat/ChatView.tsx'])).toEqual([
      'root: changed',
      'frontend: changed',
      'api: changed',
      'shared: changed',
    ]);
  });

  // The measured gap: an edit under apps/shared selects no api or frontend
  // test, because Bun stops at the workspace symlink.
  it('runs every importer of a changed workspace whole', () => {
    expect(modes(['apps/shared/src/errors/index.ts'])).toEqual([
      'root: full',
      'frontend: full',
      'api: full',
      'shared: changed',
    ]);
  });

  it('runs root and frontend whole when their API workspace dependency changes', () => {
    expect(modes(['apps/api/src/app.ts'])).toEqual([
      'root: full',
      'frontend: full',
      'api: changed',
      'shared: changed',
    ]);
  });

  it('runs root whole when its exported build-smoke fake server changes', () => {
    const file = 'apps/api/tests/support/chatgpt/fake-server.ts';

    expect(planChangedLanes([file], ['root'])).toEqual([
      {
        lane: 'root',
        mode: 'full',
        reason: `${file} is in api, which root imports by package name`,
      },
    ]);
  });

  it('runs every lane that imports the protocol SDK whole when it changes', () => {
    expect(modes(['packages/protocol/src/index.ts'])).toEqual([
      'root: full',
      'frontend: full',
      'api: full',
      'shared: full',
    ]);
  });

  // A manifest or fixture is read, not imported, so Bun selects nothing for it.
  it('runs a workspace whole when one of its non-module files changed', () => {
    expect(modes(['apps/frontend/tsconfig.test.json'])).toEqual([
      'root: full',
      'frontend: full',
      'api: changed',
      'shared: changed',
    ]);
  });

  // The root lane pins workflows, docs and manifests by reading them.
  it('runs the root lane whole for any non-module change outside the workspaces', () => {
    expect(modes(['.github/workflows/ci.yml'])).toEqual([
      'root: full',
      'frontend: changed',
      'api: changed',
      'shared: changed',
    ]);
  });

  it('keeps the root lane under --changed for a scripts module edit', () => {
    expect(modes(['scripts/lib/test.ts'])).toEqual([
      'root: changed',
      'frontend: changed',
      'api: changed',
      'shared: changed',
    ]);
  });

  it('plans only the lanes it is given', () => {
    expect(modes(['apps/shared/src/errors/index.ts'], ['api'])).toEqual(['api: full']);
  });

  it('names the file and the reason for a full run', () => {
    const [api] = planChangedLanes(['apps/shared/src/errors/index.ts'], ['api']);
    expect(api?.reason).toBe(
      'apps/shared/src/errors/index.ts is in shared, which api imports by package name'
    );
    const [shared] = planChangedLanes(['apps/shared/src/errors/index.ts'], ['shared']);
    expect(shared?.reason).toBeNull();
  });
});

describe('CHANGED_LANE_DEPENDENCIES', () => {
  const LANE_MANIFESTS: Record<ChangedLane, string> = {
    root: 'package.json',
    frontend: 'apps/frontend/package.json',
    api: 'apps/api/package.json',
    shared: 'apps/shared/package.json',
  };
  const PACKAGE_MANIFESTS: Record<string, string> = {
    [WORKSPACES.frontend.packageName]: LANE_MANIFESTS.frontend,
    [WORKSPACES.api.packageName]: LANE_MANIFESTS.api,
    [WORKSPACES.shared.packageName]: LANE_MANIFESTS.shared,
    '@mangostudio/protocol': 'packages/protocol/package.json',
  };
  const PACKAGE_LANES: Record<string, string> = {
    [WORKSPACES.frontend.packageName]: 'frontend',
    [WORKSPACES.api.packageName]: 'api',
    [WORKSPACES.shared.packageName]: 'shared',
    '@mangostudio/protocol': 'protocol',
  };

  async function workspaceDependencies(manifest: string): Promise<string[]> {
    const pkg = await Bun.file(join(ROOT_DIR, manifest)).json();
    const all = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
    return Object.entries(all)
      .filter(([, range]) => String(range).startsWith('workspace:'))
      .map(([name]) => name);
  }

  async function closure(manifest: string): Promise<string[]> {
    const seen = new Set<string>();
    const queue = await workspaceDependencies(manifest);
    for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
      if (seen.has(name)) continue;
      seen.add(name);
      const next = PACKAGE_MANIFESTS[name];
      if (!next) throw new Error(`unmapped workspace dependency: ${name} (from ${manifest})`);
      queue.push(...(await workspaceDependencies(next)));
    }
    return [...seen].map((name) => PACKAGE_LANES[name] ?? name).sort();
  }

  // A workspace dependency added to a manifest but not to the table would let
  // `--changed` run its importer under Bun's selection, which cannot see it.
  it.each(ALL_LANES)('matches the %s manifest closure', async (lane) => {
    const declared: readonly string[] = CHANGED_LANE_DEPENDENCIES[lane];
    expect([...declared].sort()).toEqual(await closure(LANE_MANIFESTS[lane]));
  });
});

describe('changedTestArg', () => {
  it('forwards the base as the value of bun test --changed', () => {
    expect(changedTestArg('7d7263d6')).toBe('--changed=7d7263d6');
  });

  it('rejects an empty base or one that would parse as a flag', () => {
    expect(() => changedTestArg('')).toThrow("Invalid --changed base: ''");
    expect(() => changedTestArg('--all')).toThrow("Invalid --changed base: '--all'");
  });
});

describe('createChangedTurboTestCommands', () => {
  const runs = planChangedLanes(['apps/api/src/app.ts'], ALL_LANES);

  // Turbo forwards everything after `--` to every task it runs, so the scoped
  // and whole lanes cannot share one invocation.
  it('splits the scoped and whole workspace lanes into separate invocations', () => {
    expect(createChangedTurboTestCommands('test:unit', runs, 'abc123')).toEqual([
      [
        'turbo',
        'run',
        'test:unit',
        '--ui=stream',
        '--log-order=stream',
        '--filter=@mangostudio/api',
        '--filter=@mangostudio/shared',
        '--',
        '--changed=abc123',
      ],
      [
        'turbo',
        'run',
        'test:unit',
        '--ui=stream',
        '--log-order=stream',
        '--filter=@mangostudio/frontend',
      ],
    ]);
  });

  it('leaves the root lane to the caller and omits an empty invocation', () => {
    const rootAndShared = planChangedLanes(['scripts/lib/test.ts'], ['root', 'shared']);
    expect(createChangedTurboTestCommands('test:integration', rootAndShared, 'abc123')).toEqual([
      [
        'turbo',
        'run',
        'test:integration',
        '--ui=stream',
        '--log-order=stream',
        '--filter=@mangostudio/shared',
        '--',
        '--changed=abc123',
      ],
    ]);
    expect(createChangedTurboTestCommands('test:unit', [], 'abc123')).toEqual([]);
  });
});
