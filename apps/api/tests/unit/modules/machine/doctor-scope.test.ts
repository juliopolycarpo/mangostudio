/**
 * Whose rows a doctor run reads.
 *
 * `mangostudio doctor` runs on the machine's own keyboard and reports on the
 * whole install, so it reads every account's rows. `GET /api/machine/doctor` is
 * a signed-in request on a hub that may hold several accounts, and the rows
 * name MCP servers and connectors — a slug and an executable command somebody
 * typed. Those belong to an account, not to the machine.
 *
 * These go through the real SQLite reader rather than a faked list function:
 * the whole fix is a `WHERE userId = ?`, and a fake list cannot be wrong about
 * one.
 */

import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServerSelect } from '../../../../src/db/types';
import type { MangoConfig } from '../../../../src/lib/config';
import { collectDoctorChecks } from '../../../../src/modules/machine/application/doctor-service';
import { FakeProcessController } from '../../../support/mocks/fake-process-controller';

let dir: string;
let dbPath: string;

/** Two accounts, each with an MCP server and a ChatGPT connector of its own. */
function seedDatabase(path: string): void {
  const db = new Database(path);
  try {
    db.run(
      'CREATE TABLE mcp_servers (id TEXT, userId TEXT, slug TEXT, command TEXT, enabled INTEGER, transport TEXT, createdAt INTEGER)'
    );
    db.run(
      "INSERT INTO mcp_servers VALUES ('m1', 'alice', 'alice-notes', '/home/alice/bin/notes-mcp', 1, 'stdio', 1)"
    );
    db.run(
      "INSERT INTO mcp_servers VALUES ('m2', 'bob', 'bob-secrets', '/home/bob/bin/secrets-mcp', 1, 'stdio', 2)"
    );
    db.run('CREATE TABLE secret_metadata (id TEXT, name TEXT, provider TEXT, userId TEXT)');
    db.run("INSERT INTO secret_metadata VALUES ('s1', 'Alice work', 'chatgpt', 'alice')");
    db.run("INSERT INTO secret_metadata VALUES ('s2', 'Bob personal', 'chatgpt', 'bob')");
    // A connector with no owner came from the environment or config.toml, so it
    // belongs to the install and every account should still see it.
    db.run("INSERT INTO secret_metadata VALUES ('s3', 'Shared', 'chatgpt', NULL)");
  } finally {
    db.close();
  }
}

function makeConfig(): MangoConfig {
  return {
    server: { host: 'localhost', port: 3001, publicUrl: '', allowedOrigins: [] },
    frontend: { host: 'localhost', port: 5173 },
    database: { path: dbPath },
    uploads: { dir: join(dir, 'uploads') },
    images: { dir: join(dir, 'images') },
    toolImages: { dir: join(dir, 'tool-images') },
    agents: { dir: join(dir, 'agents') },
    skills: { dir: join(dir, 'skills') },
    checkpoints: { dir: join(dir, 'checkpoints') },
    auth: { secret: 'x'.repeat(32), url: 'http://localhost:3001' },
    security: { trustProxy: false, allowDirectLoopback: true },
    updates: { check: true, channel: null },
    library: { backupDir: '', backupRetentionCount: 5, backupRetentionBytes: 0 },
    environments: {
      ltsRefresh: false,
      installsEnabled: false,
      container: false,
      wslExecutable: '',
    },
    terminal: { enabled: true, idleTimeoutMinutes: 30, maxSessionsPerUser: 8, scrollbackKib: 256 },
    chatgpt: { authBaseUrl: 'https://auth.openai.com', apiBaseUrl: 'https://api.openai.com' },
    secretStore: { unsafeFileFallbackDir: '' },
    corsOrigins: [],
    configFilePath: join(dir, 'config.toml'),
  } as MangoConfig;
}

/** Records the rows each collector was handed, which is what reaches a reader. */
function recordingDeps() {
  const mcpRows: McpServerSelect[][] = [];
  const connectorNames: string[][] = [];
  return {
    mcpRows,
    connectorNames,
    deps: {
      loadConfig: makeConfig,
      fs: { exists: () => true, isWritable: () => true },
      frontendDir: () => join(dir, 'frontend'),
      controller: new FakeProcessController(),
      readState: () => Promise.resolve(null),
      isCursorConfigured: () => false,
      probeRuntimeBinary: () =>
        Promise.resolve({ path: null, present: false, version: null, error: null }),
      // Faked rather than left to the real ones: those spawn `ssh -V` and walk
      // the runtime slot directories, which is machine state this test says
      // nothing about — and a spawn is the last thing a row-scoping test needs.
      probeRuntimeSlots: () => Promise.resolve([]),
      probeSshClient: () => Promise.resolve({ present: false, version: null, error: null }),
      getEmbeddedFrontend: () => null,
      collectChatGptChecks: (_config: MangoConfig, connectors: ReadonlyArray<{ name: string }>) => {
        connectorNames.push(connectors.map((connector) => connector.name));
        return Promise.resolve([]);
      },
      getBuildInfo: () => null as never,
      getCheckoutBuildInfo: () => null as never,
      readFrontendBuildInfo: () => null,
      collectSkillsChecks: () => [],
      collectMcpChecks: (rows: readonly McpServerSelect[]) => {
        mcpRows.push([...rows]);
        return Promise.resolve([]);
      },
      collectEnvironmentChecks: () => Promise.resolve([]),
      collectLibraryChecks: () => Promise.resolve([]),
    },
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'doctor-scope-'));
  dbPath = join(dir, 'database.sqlite');
  seedDatabase(dbPath);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('collectDoctorChecks scoping', () => {
  it('reads only the given account rows, plus the connectors nobody owns', async () => {
    const { deps, mcpRows, connectorNames } = recordingDeps();

    await collectDoctorChecks({ all: true, userId: 'alice' } as never, deps as never);

    // Without the scope this page would name bob-secrets and the command
    // behind it to anyone signed in to the same hub.
    expect(mcpRows[0]?.map((row) => row.slug)).toEqual(['alice-notes']);
    expect(connectorNames[0]).toEqual(['Alice work', 'Shared']);
  });

  it('reads every account for a local run with no user', async () => {
    const { deps, mcpRows, connectorNames } = recordingDeps();

    await collectDoctorChecks({ all: true } as never, deps as never);

    expect(mcpRows[0]?.map((row) => row.slug)).toEqual(['alice-notes', 'bob-secrets']);
    expect(connectorNames[0]).toEqual(['Alice work', 'Bob personal', 'Shared']);
  });
});
