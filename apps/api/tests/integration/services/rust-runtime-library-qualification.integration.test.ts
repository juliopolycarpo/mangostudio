/**
 * Qualifies the Hub's library service against the real, compiled
 * `crates/mangostudio-runtime` binary once it advertises `features.library`:
 * propagation preview → apply → undo, a mid-apply failure the runtime rolls
 * back, removal, the backup inventory and purge, and consent refresh — all
 * through the production Hub modules (`previewLibraryPropagation`,
 * `applyLibraryPropagation`, `undoLibraryPropagation`, `previewLibraryRemoval`,
 * `applyLibraryRemoval`, `describeBackupUsage`, `purgeEnvironmentBackup`) and a
 * `serve` connection, never the in-process TypeScript engine.
 *
 * The binary runs with a scratch `HOME`/`USERPROFILE` and every location
 * override scrubbed from its environment, so the Hub's `backupPolicyFor`
 * roots the store at the scratch home and no real agent home is ever read or
 * written. Backup compatibility is proven in both directions here too: a
 * Rust-written set is read, listed and undone by the TypeScript engine, and a
 * TypeScript-written set is listed and undone by the Rust runtime.
 *
 * | Pure-TS assertion | Covered here by |
 * | --- | --- |
 * | `library-propagation-apply.integration.test.ts` "creates, overwrites, and leaves an in-sync destination alone" | "propagates, rolls back, undoes and purges through the Hub" (apply half) |
 * | `apply-writes.test.ts` "stops and rolls back …" / "keeps the backup set …" | same test, blocked-store rollback |
 * | `removal-apply.test.ts` "removes a skill tree, backs it up, and hands back the undo handle" / "restores a removed resource byte-identically through the shared undo route" | same test, removal half |
 * | `backup-inventory.test.ts` listing and purge | same test, inventory half |
 * | `propagation-apply.ts` missing set → 404 (`isBackupMissingResponse`) | same test |
 * | `consent-gate.test.ts` "re-reads consent on every call" (library) | "keeps capability truthful and refuses writes under readonly and revoked consent" |
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  PropagationDecision,
  PropagationPreview,
  PropagationPreviewRequest,
  RemovalPreviewRequest,
} from '@mangostudio/shared/library';
import {
  createBackupStoreDeps,
  executeLibraryUndo,
  executePropagationWrites,
  hashResourceAt,
  listBackupSets,
  readBackupManifest,
} from '@mangostudio/shared/library/machine';
import { getDb } from '../../../src/db/database';
import { setLibraryLocationDefaultsForTest } from '../../../src/modules/app-settings/application/app-settings-service';
import { createEnvironmentService } from '../../../src/modules/environments/application/environment-service';
import { createEnvironmentRepository } from '../../../src/modules/environments/infrastructure/environment-repository';
import {
  describeBackupUsage,
  purgeEnvironmentBackup,
} from '../../../src/modules/library/application/backup-inventory';
import {
  applyLibraryPropagation,
  undoLibraryPropagation,
} from '../../../src/modules/library/application/propagation-apply';
import { previewLibraryPropagation } from '../../../src/modules/library/application/propagation-preview';
import { applyLibraryRemoval } from '../../../src/modules/library/application/removal-apply';
import { previewLibraryRemoval } from '../../../src/modules/library/application/removal-preview';
import { LibraryRequestError } from '../../../src/modules/library/domain/library-request-error';
import { connectHttpRuntime } from '../../../src/services/runtime-client/connect-http-runtime';
import {
  RuntimeConnectionManager,
  setRuntimeConnectionManagerForTests,
} from '../../../src/services/runtime-client/runtime-connection-manager';
import { setRuntimeTokenStoreForTests } from '../../../src/services/runtime-client/runtime-token-secrets';
import { insertTestUser } from '../../support/factories';
import { InMemorySecretStore } from '../../support/mocks/mock-secret-store';
import {
  cleanupMangoHome,
  resolveRustRuntimeBinary,
  scratchMangoHome,
} from '../../support/rust-runtime-binary';

const binary = resolveRustRuntimeBinary();
const ENVIRONMENT_ID = 'rust-library-box';
const TEST_USER = {
  id: 'rust-library-qualification-user',
  name: 'Rust Library Qualification User',
  email: 'rust-library-qualification@mangostudio.test',
};
const SKILL = '---\nname: gh\ndescription: GitHub\n---\n';
/** Everything the runtime's location registry reads besides the home. */
const LOCATION_OVERRIDES = [
  'SKILLS_DIR',
  'AGENTS_DIR',
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'CURSOR_CONFIG_DIR',
  'XDG_CONFIG_HOME',
];

interface Box {
  readonly home: string;
  readonly mangoHome: string;
  readonly backupRoot: string;
  readonly manager: RuntimeConnectionManager;
}

let child: ReturnType<typeof Bun.spawn> | undefined;
let scratch: string[] = [];

afterEach(async () => {
  if (child) {
    child.kill();
    await child.exited;
    child = undefined;
  }
  setRuntimeConnectionManagerForTests(undefined);
  setRuntimeTokenStoreForTests(undefined);
  setLibraryLocationDefaultsForTest(null);
  for (const path of scratch) await cleanupMangoHome(path);
  scratch = [];
  await getDb().deleteFrom('library_backups').where('userId', '=', TEST_USER.id).execute();
  await getDb().deleteFrom('environments').where('userId', '=', TEST_USER.id).execute();
  await getDb().deleteFrom('user').where('id', '=', TEST_USER.id).execute();
});

/** A scratch home, a `serve` binary rooted at it, and a Hub connection to it. */
async function connectBox(prefix: string): Promise<Box> {
  await insertTestUser(TEST_USER);
  const store = new InMemorySecretStore();
  setRuntimeTokenStoreForTests(store);
  const home = realpathSync(await scratchMangoHome(`${prefix}-home`));
  const mangoHome = await scratchMangoHome(`${prefix}-slot`);
  scratch.push(home, mangoHome);
  const token = `${prefix}-token`;
  const port = reserveEphemeralPort();
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    MANGO_HOME: mangoHome,
    MANGOSTUDIO_RUNTIME_SERVE_TOKEN: token,
  };
  for (const key of LOCATION_OVERRIDES) delete env[key];
  child = Bun.spawn({
    cmd: [binary.path, 'serve', '--listen', `127.0.0.1:${port}`, '--token', 'env'],
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const repository = createEnvironmentRepository(getDb());
  const manager = new RuntimeConnectionManager({
    resolveEnvironment: async (userId, environmentId) => repository.find(userId, environmentId),
    connectors: { http: connectHttpRuntime },
  });
  setRuntimeConnectionManagerForTests(manager);
  const service = createEnvironmentService(repository, manager, () => undefined, store);
  await service.create(TEST_USER.id, {
    id: ENVIRONMENT_ID,
    name: 'Rust library box',
    transportKind: 'http',
    config: { baseUrl: `http://127.0.0.1:${port}` },
    token,
  });
  await connectUntilListening(() => service.connect(TEST_USER.id, ENVIRONMENT_ID));
  const client = await manager.getClient(TEST_USER.id, ENVIRONMENT_ID);
  expect(client.manifest.features.library).toBe(true);
  expect(client.paths.homeDir).toBe(home);
  return { home, mangoHome, backupRoot: join(home, '.mango', 'library-backups'), manager };
}

function skillPath(box: Box, agentDir: string): string {
  return join(box.home, agentDir, 'skills', 'gh');
}

function writeSkill(box: Box, agentDir: string, body: string): void {
  mkdirSync(skillPath(box, agentDir), { recursive: true });
  writeFileSync(join(skillPath(box, agentDir), 'SKILL.md'), `${SKILL}${body}`);
}

function readSkill(box: Box, agentDir: string): string {
  return readFileSync(join(skillPath(box, agentDir), 'SKILL.md'), 'utf8');
}

function enableSkillLocations(): void {
  setLibraryLocationDefaultsForTest({
    home: { 'agents-skills': true, 'claude-skills': true, 'cursor-skills': true },
    workspace: {},
  });
}

const PROPAGATION: PropagationPreviewRequest = {
  resourceKeys: ['skill:gh'],
  targetLocationIds: ['agents-skills', 'claude-skills', 'cursor-skills'],
  environmentIds: [ENVIRONMENT_ID],
};

/** Adopt the claude-skills copy everywhere the preview offers. */
function adoptClaude(preview: PropagationPreview): PropagationDecision[] {
  return preview.entries.map((entry) => {
    const winner = entry.sourceGroups.find((group) => group.locationIds.includes('claude-skills'));
    if (!winner) throw new Error('expected a source group holding claude-skills | received none');
    return {
      resourceKey: entry.resourceKey,
      resolution: 'adopt-group',
      winnerContentHash: winner.contentHash,
      destinations: entry.destinations.map((destination) => ({
        environmentId: destination.environmentId,
        locationId: destination.locationId,
        action: 'apply' as const,
      })),
    };
  });
}

async function applyClaudeEverywhere() {
  const preview = await previewLibraryPropagation(TEST_USER.id, PROPAGATION);
  return await applyLibraryPropagation(TEST_USER.id, {
    previewToken: preview.previewToken,
    stateHash: preview.stateHash,
    request: PROPAGATION,
    decisions: adoptClaude(preview),
  });
}

async function setProfile(box: Box, profile: 'full' | 'readonly' | 'none'): Promise<void> {
  const setup = Bun.spawn({
    cmd: [binary.path, 'setup', '--slot', 'remote', '--profile', profile],
    env: { ...process.env, MANGO_HOME: box.mangoHome },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(await setup.exited).toBe(0);
}

describe('Real Rust runtime library qualification through the Hub', () => {
  it.skipIf(!binary.available)(
    'propagates, rolls back, undoes, removes and purges through the Hub',
    async () => {
      const box = await connectBox('library-hub');
      enableSkillLocations();
      writeSkill(box, '.claude', 'winner\n');
      writeSkill(box, '.cursor', 'stale\n');
      mkdirSync(join(box.home, '.agents', 'skills'), { recursive: true });

      // Rollback: the agents-skills create lands, then the cursor-skills
      // overwrite cannot back its copy up (the store is a file), and the
      // runtime compensates the create before answering.
      mkdirSync(join(box.home, '.mango'), { recursive: true });
      writeFileSync(box.backupRoot, 'not a directory');
      const refused = await applyClaudeEverywhere();
      expect(refused.failed).toMatchObject([
        { environmentId: ENVIRONMENT_ID, locationId: 'cursor-skills', reason: 'write-failed' },
      ]);
      expect({
        applied: refused.applied,
        partial: refused.partial,
        backups: refused.backups,
      }).toEqual({ applied: [], partial: false, backups: [] });
      expect(existsSync(skillPath(box, '.agents'))).toBe(false);
      expect(readSkill(box, '.cursor')).toContain('stale');
      rmSync(box.backupRoot);

      const applied = await applyClaudeEverywhere();
      expect(applied.failed).toEqual([]);
      expect(applied.applied.map((row) => `${row.locationId}:${row.operation}`).sort()).toEqual([
        'agents-skills:create',
        'cursor-skills:overwrite',
      ]);
      expect(applied.backups).toEqual([
        { environmentId: ENVIRONMENT_ID, backupId: expect.any(String) },
      ]);
      const applySet = applied.backups[0]?.backupId ?? '';
      expect(readSkill(box, '.agents')).toContain('winner');
      expect(readSkill(box, '.cursor')).toContain('winner');

      // Rust-written set, read by the TypeScript engine.
      const tsStore = createBackupStoreDeps({ backupRoot: box.backupRoot });
      const manifest = await readBackupManifest(applySet, tsStore);
      expect(manifest).toMatchObject({
        version: 3,
        operation: 'propagation',
        environmentId: ENVIRONMENT_ID,
      });
      expect(manifest?.entries.map((entry) => entry.locationId).sort()).toEqual([
        'agents-skills',
        'cursor-skills',
      ]);

      // The Hub's inventory lists what the runtime reports, and it is the
      // same row the TypeScript store reports for the same bytes.
      const usage = await describeBackupUsage(TEST_USER.id);
      const row = usage.sets.find(
        (set) => set.environmentId === ENVIRONMENT_ID && set.backupId === applySet
      );
      const {
        environmentId: _environment,
        availability,
        ...listed
      } = row ?? {
        environmentId: '',
        availability: 'missing',
      };
      expect(availability).toBe('available');
      expect(listed).toEqual(
        (await listBackupSets(tsStore)).find((set) => set.backupId === applySet) ?? {}
      );

      const undone = await undoLibraryPropagation(
        applySet,
        { environmentId: ENVIRONMENT_ID },
        TEST_USER.id
      );
      expect(undone.restored.map((entry) => entry.locationId)).toEqual(['cursor-skills']);
      expect(undone.removed.map((entry) => entry.locationId)).toEqual(['agents-skills']);
      expect(undone.environmentId).toBe(ENVIRONMENT_ID);
      expect(readSkill(box, '.cursor')).toContain('stale');
      expect(existsSync(skillPath(box, '.agents'))).toBe(false);

      const missing = await undoLibraryPropagation(
        'never-written',
        { environmentId: ENVIRONMENT_ID },
        TEST_USER.id
      ).catch((error: unknown) => error);
      expect(missing).toBeInstanceOf(LibraryRequestError);
      expect((missing as LibraryRequestError).status).toBe(404);

      // Removal through the Hub, restored by the TypeScript engine from the
      // Rust-written set.
      const removalRequest: RemovalPreviewRequest = {
        resourceKeys: ['skill:gh'],
        locationIds: ['cursor-skills'],
        environmentIds: [ENVIRONMENT_ID],
      };
      const removalPreview = await previewLibraryRemoval(TEST_USER.id, removalRequest);
      const removed = await applyLibraryRemoval(TEST_USER.id, {
        previewToken: removalPreview.previewToken,
        stateHash: removalPreview.stateHash,
        request: removalRequest,
        decisions: removalPreview.entries.map((entry) => ({
          resourceKey: entry.resourceKey,
          locations: entry.locations.map((location) => ({
            environmentId: location.environmentId,
            locationId: location.locationId,
            action: 'remove' as const,
          })),
        })),
        acknowledgeLastCopy: [],
      });
      expect(removed.failed).toEqual([]);
      expect(removed.removed.map((entry) => entry.locationId)).toEqual(['cursor-skills']);
      const removalSet = removed.backups[0]?.backupId ?? '';
      expect(existsSync(skillPath(box, '.cursor'))).toBe(false);
      const restored = await executeLibraryUndo({
        backupRoot: box.backupRoot,
        backupId: removalSet,
        pathEnv: { platform: process.platform, homeDir: box.home, env: {} },
      });
      expect(restored.restored.map((entry) => entry.locationId)).toEqual(['cursor-skills']);
      expect(readSkill(box, '.cursor')).toContain('stale');

      // TypeScript-written set in the same store, listed and undone by Rust.
      const tsSet = '2026-09-23T10-15-44.087Z-00000000000000ff';
      const tsWrite = await executePropagationWrites({
        backupRoot: box.backupRoot,
        pathEnv: { platform: process.platform, homeDir: box.home, env: {} },
        backupId: tsSet,
        environmentId: ENVIRONMENT_ID,
        operations: [
          {
            resourceKey: 'skill:gh',
            locationId: 'agents-skills',
            slug: 'gh',
            operation: 'create',
            kind: 'directory',
            expectedContentHash: await hashResourceAt(skillPath(box, '.claude'), 'directory'),
            destinationRoot: join(box.home, '.agents', 'skills'),
            sourceDir: skillPath(box, '.claude'),
          },
        ],
      });
      expect(tsWrite.failed).toEqual([]);
      const listedByRust = await describeBackupUsage(TEST_USER.id);
      expect(
        listedByRust.sets.find(
          (set) => set.environmentId === ENVIRONMENT_ID && set.backupId === tsSet
        )
      ).toMatchObject({ availability: 'available', operation: 'propagation' });
      const rustUndo = await undoLibraryPropagation(
        tsSet,
        { environmentId: ENVIRONMENT_ID },
        TEST_USER.id
      );
      expect(rustUndo.removed.map((entry) => entry.locationId)).toEqual(['agents-skills']);
      expect(existsSync(skillPath(box, '.agents'))).toBe(false);

      for (const backupId of [applySet, removalSet, tsSet]) {
        await purgeEnvironmentBackup(TEST_USER.id, ENVIRONMENT_ID, backupId);
      }
      const purged = await describeBackupUsage(TEST_USER.id);
      expect(purged.sets.filter((set) => set.environmentId === ENVIRONMENT_ID)).toEqual([]);
      expect(existsSync(join(box.backupRoot, applySet))).toBe(false);
    },
    60_000
  );

  it.skipIf(!binary.available)(
    'writes a MangoStudio location on the remote machine, not under the Hub pins',
    async () => {
      const box = await connectBox('library-hub-pins');
      enableSkillLocations();
      writeSkill(box, '.claude', 'winner\n');
      const request: PropagationPreviewRequest = {
        resourceKeys: ['skill:gh'],
        targetLocationIds: ['claude-skills', 'mango-skills'],
        environmentIds: [ENVIRONMENT_ID],
      };
      const preview = await previewLibraryPropagation(TEST_USER.id, request);
      const applied = await applyLibraryPropagation(TEST_USER.id, {
        previewToken: preview.previewToken,
        stateHash: preview.stateHash,
        request,
        decisions: adoptClaude(preview),
      });
      expect(applied.failed).toEqual([]);
      expect(applied.applied.map((row) => row.locationId)).toEqual(['mango-skills']);
      expect(readSkill(box, '.mango')).toContain('winner');
      const undone = await undoLibraryPropagation(
        applied.backups[0]?.backupId ?? '',
        { environmentId: ENVIRONMENT_ID },
        TEST_USER.id
      );
      expect(undone.removed.map((entry) => entry.locationId)).toEqual(['mango-skills']);
      expect(existsSync(skillPath(box, '.mango'))).toBe(false);
    },
    60_000
  );

  it.skipIf(!binary.available)(
    'keeps capability truthful and refuses writes under readonly and revoked consent',
    async () => {
      const box = await connectBox('library-hub-consent');
      enableSkillLocations();
      writeSkill(box, '.claude', 'winner\n');
      mkdirSync(join(box.home, '.agents', 'skills'), { recursive: true });

      await setProfile(box, 'readonly');
      const readonly = await box.manager.refreshManifest(TEST_USER.id, ENVIRONMENT_ID);
      expect(readonly.manifest?.allow).toMatchObject({ library: true, fsWrite: false });
      expect(readonly.manifest?.features.library).toBe(true);
      // Listing is a read and stays available. The Hub blocks the write
      // itself from the refreshed allow, and the runtime independently
      // refuses one sent anyway; nothing lands either way.
      expect((await describeBackupUsage(TEST_USER.id)).unreachableEnvironmentIds).toEqual([]);
      const blocked = await applyClaudeEverywhere().catch((error: unknown) => error);
      expect(blocked).toBeInstanceOf(LibraryRequestError);
      expect((blocked as Error).message).toContain('environment-readonly');
      const client = await box.manager.getClient(TEST_USER.id, ENVIRONMENT_ID);
      const denied = await client.library
        .gc({ backupRoot: box.backupRoot, purgeBackupIds: [] })
        .catch((error: unknown) => error);
      expect(denied).toMatchObject({
        name: 'RuntimeConsentDeniedError',
        details: { method: 'library.gc', missing: ['fsWrite'] },
      });
      expect(await client.library.backups({ backupRoot: box.backupRoot })).toEqual({ sets: [] });
      expect(existsSync(skillPath(box, '.agents'))).toBe(false);

      await setProfile(box, 'none');
      const revoked = await box.manager.refreshManifest(TEST_USER.id, ENVIRONMENT_ID);
      expect(revoked.manifest?.features.library).toBe(false);
      const unavailable = await previewLibraryPropagation(TEST_USER.id, PROPAGATION).catch(
        (error: unknown) => error
      );
      expect(unavailable).toBeInstanceOf(Error);
      expect(existsSync(skillPath(box, '.agents'))).toBe(false);

      await setProfile(box, 'full');
      const restored = await box.manager.refreshManifest(TEST_USER.id, ENVIRONMENT_ID);
      expect(restored.manifest?.features.library).toBe(true);
    },
    60_000
  );
});

/** An unused TCP port on loopback, released back to the OS before returning. */
function reserveEphemeralPort(): number {
  const server = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open() {
        /* unused */
      },
      data() {
        /* unused */
      },
      close() {
        /* unused */
      },
    },
  });
  const { port } = server;
  server.stop(true);
  return port;
}

/** Retries the real Hub dial until `serve` is listening (see the sibling suite). */
async function connectUntilListening<T>(attempt: () => Promise<T>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await attempt();
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await Bun.sleep(50);
    }
  }
}
