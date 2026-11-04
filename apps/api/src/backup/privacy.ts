import type { Database } from 'bun:sqlite';

/** Only inventoried portable tables retain rows; future tables fail closed. */
const PORTABLE_TABLES = new Set([
  'user',
  'chats',
  'messages',
  'generated_images',
  'chat_attachments',
  'user_app_settings',
  'user_skill_settings',
  'chat_todos',
  'file_checkpoints',
  'message_uncheckpointed_sources',
  'user_tool_identities',
  'environments',
  'mcp_servers',
  'kysely_migration',
  'kysely_migration_lock',
]);

export const BACKUP_EXCLUSIONS = [
  'OS keychain and vendor-managed credentials',
  'connector credentials and environment variables',
  'sessions, accounts, API keys, runtime pairing tokens and secret metadata',
  'runtime binaries, pointers, service state, caches, logs, audit and transient state',
  'symlinks and special files (capture refuses them)',
];

/** Redact only the private snapshot, then vacuum away deleted credential bytes. */
export function redactBackupDatabase(db: Database, checkpoints: boolean): void {
  db.exec('PRAGMA foreign_keys=OFF; PRAGMA secure_delete=ON;');
  const tables = new Set(
    (db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(
      (row) => row.name
    )
  );
  for (const table of tables) {
    if (!PORTABLE_TABLES.has(table) && !table.startsWith('sqlite_')) {
      db.exec(`DELETE FROM "${table.replaceAll('"', '""')}"`);
    }
  }
  // Opaque connection/launch parameters can embed credentials. Keep disabled metadata only.
  if (tables.has('environments')) db.exec("UPDATE environments SET configJson='{}', enabled=0");
  if (tables.has('mcp_servers'))
    db.exec(
      "UPDATE mcp_servers SET envJson='{}', argsJson='[]', command=NULL, url=NULL, enabled=0"
    );
  for (const table of ['user_provider_settings', 'user_tool_settings', 'user_agent_settings']) {
    // These are arbitrary provider/tool payloads, not a finite credential schema.
    if (tables.has(table)) db.exec(`DELETE FROM "${table}"`);
  }
  if (tables.has('chats'))
    db.exec('UPDATE chats SET lastProviderState=NULL, lastContextState=NULL');
  if (tables.has('messages')) db.exec('UPDATE messages SET providerState=NULL');
  if (!checkpoints && tables.has('file_checkpoints')) db.exec('DELETE FROM file_checkpoints');
  db.exec('VACUUM');
}
