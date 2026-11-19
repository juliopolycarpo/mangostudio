import { describe, expect, it } from 'bun:test';

import { sql } from 'kysely';

import { getDb } from '../../../../src/db/database';
import { IMAGE_REFERENCE_SOURCES } from '../../../../src/modules/generated-images/infrastructure/image-reference-sources';

/**
 * Tables with text columns that no writer fills with a generated image URL.
 * Adding a table to the schema fails the test below until it is registered in
 * `IMAGE_REFERENCE_SOURCES` or listed here with the reason it cannot hold one.
 */
const TABLES_WITHOUT_IMAGE_URLS: Readonly<Record<string, string>> = {
  account: 'auth provider links',
  activity_events: 'activity log entries (kind, ids, workdir)',
  apikey: 'API key records',
  chat_attachments: 'user uploads, served from /uploads/, not /images/',
  chat_todos: 'agent todo items',
  connector_usage_samples: 'usage counters',
  environment_install_runs: 'toolchain install records',
  environment_toolchains: 'toolchain selections',
  environments: 'environment connection settings',
  external_account_limits_cache: 'vendor rate-limit cache',
  external_agent_disclosures: 'disclosure acknowledgements',
  external_session_adoption_leases: 'session adoption leases',
  external_session_continuations: 'vendor session continuation ids',
  external_turn_attempts: 'turn attempt bookkeeping',
  file_checkpoints: 'workspace file snapshots',
  kysely_migration: 'migration bookkeeping',
  kysely_migration_lock: 'migration bookkeeping',
  library_backups: 'library backup records',
  library_divergence_acks: 'library divergence acknowledgements',
  mcp_servers: 'MCP server definitions',
  message_uncheckpointed_sources: 'file checkpoint source markers',
  observability_snapshot: 'observability counters',
  product_operations: 'idempotency records',
  runtime_pairing_tokens: 'pairing token hashes',
  secret_metadata: 'secret labels',
  session: 'auth sessions',
  user: 'accounts',
  user_agent_settings: 'per-user agent settings',
  user_app_settings: 'per-user app settings',
  user_provider_settings: 'per-user provider settings',
  user_skill_settings: 'per-user skill settings',
  user_tool_identities: 'tool avatars, stored in their own image store',
  user_tool_settings: 'per-user tool settings',
  verification: 'auth verification tokens',
};

/**
 * Text columns of a registered table that are known not to carry an image URL,
 * keyed `table.column`. A column added to `messages`, `generated_images`,
 * `message_checkpoint_deltas` or `chats` fails the test until it is registered
 * or listed here.
 */
const COLUMNS_WITHOUT_IMAGE_URLS: Readonly<Record<string, string>> = {
  'chats.id': 'identifier',
  'chats.title': 'user-typed title',
  'chats.model': 'model name',
  'chats.textModel': 'model name',
  'chats.imageModel': 'model name',
  'chats.userId': 'identifier',
  'chats.workdir': 'workspace path',
  'chats.environmentId': 'identifier',
  'chats.runnerKind': 'enum',
  'chats.runnerAgentId': 'identifier',
  'chats.runnerTargetId': 'identifier',
  'chats.runnerPermissionLevel': 'enum',
  'chats.runnerApprovalRouting': 'enum',
  'chats.runnerModel': 'model name',
  'chats.runnerEffort': 'enum',
  'chats.searchText': 'title and workdir search key',
  'generated_images.id': 'identifier',
  'generated_images.userId': 'identifier',
  'generated_images.chatId': 'identifier',
  'generated_images.messageId': 'identifier',
  'generated_images.toolCallId': 'identifier',
  'generated_images.prompt': 'prompt text',
  'generated_images.modelName': 'model name',
  'generated_images.generationTime': 'duration label',
  'generated_images.metadataJson': 'generation settings (quality, size)',
  'message_checkpoint_deltas.messageId': 'identifier',
  'messages.id': 'identifier',
  'messages.chatId': 'identifier',
  'messages.role': 'enum',
  'messages.generationTime': 'duration label',
  'messages.modelName': 'model name',
  'messages.styleParams': 'generation style settings',
  'messages.interactionMode': 'enum',
};

interface ColumnRow {
  table: string;
  column: string;
}

/**
 * The `table.column` keys of `columns` that are neither registered as an image
 * reference source nor classified as holding no image URL. A column of a
 * registered table needs its own entry; a table not registered needs one entry
 * for the whole table.
 */
function findUnclassifiedColumns(columns: readonly ColumnRow[]): string[] {
  const registered = new Set(
    IMAGE_REFERENCE_SOURCES.map((source) => `${source.table}.${source.column}`)
  );
  const registeredTables = new Set<string>(IMAGE_REFERENCE_SOURCES.map((source) => source.table));
  return columns
    .filter(({ table, column }) => {
      const key = `${table}.${column}`;
      if (registered.has(key)) return false;
      if (registeredTables.has(table)) return !(key in COLUMNS_WITHOUT_IMAGE_URLS);
      return !(table in TABLES_WITHOUT_IMAGE_URLS);
    })
    .map(({ table, column }) => `${table}.${column}`);
}

async function listTextColumns(): Promise<ColumnRow[]> {
  const { rows } = await sql<ColumnRow>`
    SELECT m.name AS "table", c.name AS "column"
    FROM sqlite_master m, pragma_table_info(m.name) c
    WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%'
      AND (c.type LIKE '%char%' OR c.type LIKE '%clob%' OR c.type LIKE '%text%' OR c.type LIKE '%json%')
    ORDER BY m.name, c.cid`.execute(getDb());
  return rows;
}

describe('generated image reference sources', () => {
  it('classifies every text column in the schema as a reference source or known not to hold an image URL', async () => {
    const unclassified = findUnclassifiedColumns(await listTextColumns());

    expect(
      unclassified,
      `(image references): columns neither registered in IMAGE_REFERENCE_SOURCES nor listed as ` +
        `holding no image URL | received: ${unclassified.join(', ')} | expected: none. A column ` +
        `a writer can fill with /images/<name> must be registered, or the sweep deletes its file.`
    ).toEqual([]);
  });

  it('registers only columns that exist, with a page key and chat scope that exist too', async () => {
    const columns = new Set(
      (
        await sql<ColumnRow>`
          SELECT m.name AS "table", c.name AS "column"
          FROM sqlite_master m, pragma_table_info(m.name) c
          WHERE m.type = 'table'`.execute(getDb())
      ).rows.map(({ table, column }) => `${table}.${column}`)
    );

    const missing = IMAGE_REFERENCE_SOURCES.flatMap((source) => {
      const wanted = [
        source.column,
        ...source.pageKey.filter((key) => key !== 'rowid'),
        'column' in source.chat ? source.chat.column : source.chat.messageColumn,
      ];
      return wanted
        .filter((column) => !columns.has(`${source.table}.${column}`))
        .map((column) => `${source.table}.${column}`);
    });

    expect(
      missing,
      `(image references): registered columns absent from the schema | received: ${missing.join(', ')} | expected: none`
    ).toEqual([]);
  });

  it('keeps no stale entry in the known-not-image lists', async () => {
    const present = new Set(
      (await listTextColumns()).map(({ table, column }) => `${table}.${column}`)
    );
    const tables = new Set((await listTextColumns()).map(({ table }) => table));

    const stale = [
      ...Object.keys(TABLES_WITHOUT_IMAGE_URLS).filter((table) => !tables.has(table)),
      ...Object.keys(COLUMNS_WITHOUT_IMAGE_URLS).filter((key) => !present.has(key)),
    ];

    expect(
      stale,
      `(image references): entries naming a table or column that no longer exists | received: ${stale.join(', ')} | expected: none`
    ).toEqual([]);
  });

  it('flags a new table and a new column on a registered table, and passes the registered ones', () => {
    const flagged = findUnclassifiedColumns([
      { table: 'message_checkpoint_deltas', column: 'delta' },
      { table: 'message_checkpoint_deltas', column: 'sidecarJson' },
      { table: 'chat_snapshots', column: 'bodyJson' },
      { table: 'chat_todos', column: 'items' },
    ]);

    expect(flagged).toEqual(['message_checkpoint_deltas.sidecarJson', 'chat_snapshots.bodyJson']);
  });
});
