import { Database } from 'bun:sqlite';
import { afterEach, expect, it } from 'bun:test';
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BackupManifestSchema } from '@mangostudio/shared/backup';
import { Kysely } from 'kysely';
import { Migrator } from 'kysely/migration';
import Value from 'typebox/value';

import { CAPTURE_LIMITS, captureBackup, portableBackupName } from '../../../src/backup/capture';
import { acquireCaptureLock } from '../../../src/backup/capture-lock';
import { parseBackupArgs } from '../../../src/cli/commands/backup';
import { createBunSqliteDialect } from '../../../src/db/bun-sqlite-dialect';
import { allMigrations } from '../../../src/db/migrations';
import { getConfig } from '../../../src/lib/config';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mango-capture-test-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const config = {
    ...getConfig(),
    database: { path: join(root, 'configured.sqlite') },
    configFilePath: join(root, 'config.toml'),
    auth: { ...getConfig().auth, secret: 'hub-auth-sensitive-fixture' },
    uploads: { dir: join(root, 'custom-uploads') },
    images: { dir: join(root, 'custom-images') },
    toolImages: { dir: join(root, 'avatars') },
    agents: { dir: join(root, 'agents') },
    skills: { dir: join(root, 'skills') },
    checkpoints: { dir: join(root, 'checkpoints') },
  };
  const db = new Database(config.database.path);
  cleanups.push(() => {
    db.close();
    return Promise.resolve();
  });
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE future_credentials(secret TEXT);
    INSERT INTO future_credentials VALUES('future-sensitive-fixture');
    CREATE TABLE messages(id TEXT, text TEXT, providerState TEXT);
    CREATE TABLE chats(id TEXT, lastProviderState TEXT, lastContextState TEXT);
    CREATE TABLE account(id TEXT, accessToken TEXT);
    CREATE TABLE session(id TEXT, token TEXT);
    CREATE TABLE apikey(id TEXT, key TEXT);
    CREATE TABLE runtime_pairing_tokens(id TEXT, tokenHash TEXT);
    CREATE TABLE secret_metadata(id TEXT, maskedSuffix TEXT);
    CREATE TABLE user_provider_settings(id TEXT, settingsJson TEXT);
    CREATE TABLE mcp_servers(id TEXT, envJson TEXT, argsJson TEXT, command TEXT, url TEXT, enabled INTEGER);
    CREATE TABLE environments(id TEXT, configJson TEXT, enabled INTEGER);
    CREATE TABLE file_checkpoints(id TEXT);
    INSERT INTO messages VALUES('m', 'keep this conversation', 'opaque-sensitive-fixture');
    INSERT INTO account VALUES('a','oauth-sensitive-fixture');
    INSERT INTO session VALUES('s','session-sensitive-fixture');
    INSERT INTO apikey VALUES('k','apikey-sensitive-fixture');
    INSERT INTO user_provider_settings VALUES('p','provider-sensitive-fixture');
    INSERT INTO mcp_servers VALUES('c','env-sensitive-fixture','args-sensitive-fixture','secret-command','https://secret.example',1);
    INSERT INTO environments VALUES('e','environment-sensitive-fixture',1);
    INSERT INTO file_checkpoints VALUES('checkpoint');
  `);
  await mkdir(config.uploads.dir);
  await mkdir(config.checkpoints.dir);
  await writeFile(join(config.uploads.dir, 'media.txt'), 'media fixture');
  await writeFile(join(config.uploads.dir, '.env'), 'file-sensitive-fixture');
  await writeFile(join(config.checkpoints.dir, 'checkpoint.txt'), 'checkpoint fixture');
  return { root, db, config, output: join(root, 'backup.tar.gz') };
}

it('captures configured data, hashes, WAL contents and a redacted intact database', async () => {
  const { config, db, output } = await fixture();
  const chunked = Uint8Array.from({ length: 3 * 64 * 1024 + 17 }, (_, index) => index % 251);
  await writeFile(join(config.uploads.dir, 'chunks.bin'), chunked);
  const manifest = await captureBackup(
    config,
    { output, checkpoints: true, includeSecrets: false },
    'test'
  );
  expect(Value.Check(BackupManifestSchema, manifest)).toBe(true);
  const files = await new Bun.Archive(await readFile(output)).files();
  expect(files.has('checkpoints/checkpoint.txt')).toBe(true);
  expect(files.has('uploads/.env')).toBe(false);
  expect(await files.get('uploads/media.txt')?.text()).toBe('media fixture');
  expect(
    new Uint8Array((await files.get('uploads/chunks.bin')?.arrayBuffer()) as ArrayBuffer)
  ).toEqual(chunked);
  for (const entry of manifest.files) {
    const bytes = await files.get(entry.path)?.arrayBuffer();
    expect(bytes?.byteLength).toBe(entry.sizeBytes);
    expect(new Bun.CryptoHasher('sha256').update(bytes as ArrayBuffer).digest('hex')).toBe(
      entry.sha256
    );
  }
  const snapshotBytes = await files.get('database.sqlite')?.arrayBuffer();
  expect(Buffer.from(snapshotBytes as ArrayBuffer).includes(Buffer.from('sensitive-fixture'))).toBe(
    false
  );
  const snapshot = Database.deserialize(snapshotBytes as ArrayBuffer);
  try {
    expect(snapshot.query('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    expect(snapshot.query('SELECT text FROM messages').get()).toEqual({
      text: 'keep this conversation',
    });
    expect(snapshot.query('SELECT count(*) AS count FROM account').get()).toEqual({ count: 0 });
  } finally {
    snapshot.close();
  }
  expect(db.query('SELECT accessToken FROM account').get()).toEqual({
    accessToken: 'oauth-sensitive-fixture',
  });
  expect(await files.get('config.json')?.text()).not.toContain('hub-auth-sensitive-fixture');
  if (process.platform !== 'win32') expect((await lstat(output)).mode & 0o777).toBe(0o600);
});

it('includes only the explicitly named portable auth secret and can omit checkpoints', async () => {
  const { config, output } = await fixture();
  const manifest = await captureBackup(
    config,
    { output, checkpoints: false, includeSecrets: true },
    'test'
  );
  const files = await new Bun.Archive(await readFile(output)).files();
  expect(manifest.portableSecrets).toEqual(['hub-auth-secret']);
  expect(await files.get('config.json')?.text()).toContain('hub-auth-sensitive-fixture');
  expect(files.has('checkpoints/checkpoint.txt')).toBe(false);
  const snapshot = Database.deserialize(
    (await files.get('database.sqlite')?.arrayBuffer()) as ArrayBuffer
  );
  try {
    expect(snapshot.query('SELECT count(*) AS count FROM file_checkpoints').get()).toEqual({
      count: 0,
    });
  } finally {
    snapshot.close();
  }
});

it('reserves the write boundary, rejects a mutation race and cleans private staging', async () => {
  const { root, config, db, output } = await fixture();
  const barrier = {
    async afterFilesStaged() {
      const staging = (await readdir(root)).find((name) => name.startsWith('.mango-backup-'));
      expect(staging).toBeDefined();
      if (process.platform !== 'win32') {
        expect((await lstat(join(root, staging as string))).mode & 0o777).toBe(0o700);
        expect((await lstat(join(root, staging as string, 'database.sqlite'))).mode & 0o777).toBe(
          0o600
        );
      }
      await expect(acquireCaptureLock(config.database.path)).rejects.toThrow('already in use');
      expect(() => db.exec("INSERT INTO messages VALUES('racing','changed',NULL)")).toThrow(
        'locked'
      );
      await writeFile(join(config.uploads.dir, 'media.txt'), 'changed during capture');
    },
  };
  await expect(
    captureBackup(config, { output, checkpoints: true, includeSecrets: false }, 'test', barrier)
  ).rejects.toThrow('changed during capture');
  expect(
    (await readdir(root)).filter(
      (name) => name.startsWith('.mango-backup') || name.endsWith('.capture-lock')
    )
  ).toEqual([]);
  expect(await Bun.file(output).exists()).toBe(false);
});

it('cancels after staging without publishing or retaining temporary files', async () => {
  const { root, config, output } = await fixture();
  const controller = new AbortController();
  await expect(
    captureBackup(
      config,
      { output, checkpoints: true, includeSecrets: false, signal: controller.signal },
      'test',
      {
        afterFilesStaged() {
          controller.abort(new Error('fixture capture cancellation'));
          return Promise.resolve();
        },
      }
    )
  ).rejects.toThrow('fixture capture cancellation');
  expect(await Bun.file(output).exists()).toBe(false);
  expect((await readdir(root)).some((name) => name.startsWith('.mango-backup'))).toBe(false);
});

it('refuses an oversized file before copying and preserves an existing destination', async () => {
  const { root, config, output } = await fixture();
  const large = join(config.uploads.dir, 'large.bin');
  await writeFile(large, '');
  await truncate(large, CAPTURE_LIMITS.fileBytes + 1);
  await expect(
    captureBackup(config, { output, checkpoints: true, includeSecrets: false }, 'test')
  ).rejects.toThrow('byte limit');
  await rm(large);
  await writeFile(output, 'existing archive');
  await expect(
    captureBackup(config, { output, checkpoints: true, includeSecrets: false }, 'test')
  ).rejects.toThrow();
  expect(await readFile(output, 'utf8')).toBe('existing archive');
  expect((await readdir(root)).some((name) => name.startsWith('.mango-backup'))).toBe(false);
});

it('refuses source links, overlapping output and nonportable names', async () => {
  const { config, output } = await fixture();
  await expect(
    captureBackup(
      config,
      {
        output: join(config.uploads.dir, 'backup.tar.gz'),
        checkpoints: true,
        includeSecrets: false,
      },
      'test'
    )
  ).rejects.toThrow('overlaps');
  if (process.platform !== 'win32') {
    await symlink(config.database.path, join(config.uploads.dir, 'escape'));
    await expect(
      captureBackup(config, { output, checkpoints: true, includeSecrets: false }, 'test')
    ).rejects.toThrow('symlinks');
  }
  for (const name of ['CON.txt', 'a:b', '../x', 'end.', 'x\\y'])
    expect(portableBackupName(name)).toBe(false);
  expect(portableBackupName('portable-fixture.md')).toBe(true);
});

it('parses explicit privacy flags and rejects unknown arguments', () => {
  expect(parseBackupArgs(['out.tar.gz'])).toEqual({
    output: 'out.tar.gz',
    checkpoints: true,
    includeSecrets: false,
  });
  expect(parseBackupArgs(['out.tar.gz', '--include-secrets', '--no-checkpoints'])).toEqual({
    output: 'out.tar.gz',
    checkpoints: false,
    includeSecrets: true,
  });
  expect(() => parseBackupArgs([])).toThrow('Missing');
  expect(() => parseBackupArgs(['--restore'])).toThrow('Unknown');
});

it('releases process ownership automatically after a crashed lock holder', async () => {
  const { config } = await fixture();
  const modulePath = fileURLToPath(new URL('../../../src/backup/capture-lock.ts', import.meta.url));
  const code = `import { acquireCaptureLock } from ${JSON.stringify(modulePath)};
    await acquireCaptureLock(${JSON.stringify(config.database.path)});
    console.log('locked'); await Bun.stdin.text();`;
  const child = Bun.spawn([process.execPath, '--eval', code], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  try {
    const reader = child.stdout.getReader();
    const ready = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error('lock holder did not become ready')), 5000);
        timer.unref();
      }),
    ]);
    expect(new TextDecoder().decode(ready.value)).toContain('locked');
    reader.releaseLock();
    await expect(acquireCaptureLock(config.database.path)).rejects.toThrow('already in use');
  } finally {
    child.kill('SIGKILL');
    await child.exited;
  }
  const release = await acquireCaptureLock(config.database.path);
  await release();
});

it('captures the complete current migrated schema with valid foreign keys', async () => {
  const { root, config, output } = await fixture();
  config.database.path = join(root, 'migrated.sqlite');
  const sqlite = new Database(config.database.path);
  const db = new Kysely({ dialect: createBunSqliteDialect(sqlite) });
  try {
    const { error } = await new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(allMigrations) },
    }).migrateToLatest();
    if (error) throw error instanceof Error ? error : new Error('Fixture migrations failed.');
    sqlite.exec(`INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES('fixture-user','Fixture','backup-fixture@example.test',0,'2026-01-01','2026-01-01');
      INSERT INTO chats(id,title,createdAt,updatedAt,userId) VALUES('fixture-chat','Retained chat',1,1,'fixture-user');`);
    await captureBackup(config, { output, checkpoints: true, includeSecrets: false }, 'test');
    const files = await new Bun.Archive(await readFile(output)).files();
    const snapshot = Database.deserialize(
      (await files.get('database.sqlite')?.arrayBuffer()) as ArrayBuffer
    );
    try {
      expect(snapshot.query('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(snapshot.query('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    } finally {
      snapshot.close();
    }
  } finally {
    await db.destroy();
  }
});

it('refuses excessive nesting before publishing a partial archive', async () => {
  const { config, output } = await fixture();
  let directory = config.uploads.dir;
  for (let depth = 0; depth <= CAPTURE_LIMITS.depth; depth++) {
    directory = join(directory, 'nested');
    await mkdir(directory);
  }
  await expect(
    captureBackup(config, { output, checkpoints: true, includeSecrets: false }, 'test')
  ).rejects.toThrow('depth limit');
  expect(await Bun.file(output).exists()).toBe(false);
});

it.skipIf(process.platform === 'win32')(
  'checks canonical output and config paths against data roots',
  async () => {
    const { root, config, output } = await fixture();
    await mkdir(join(config.uploads.dir, 'destination'));
    await symlink(join(config.uploads.dir, 'destination'), join(root, 'output-alias'));
    await expect(
      captureBackup(
        config,
        {
          output: join(root, 'output-alias', 'archive.tar.gz'),
          checkpoints: true,
          includeSecrets: false,
        },
        'test'
      )
    ).rejects.toThrow('overlaps');
    await writeFile(join(config.uploads.dir, 'raw-config.toml'), 'auth-sensitive-fixture');
    await symlink(join(config.uploads.dir, 'raw-config.toml'), join(root, 'config-alias'));
    config.configFilePath = join(root, 'config-alias');
    await expect(
      captureBackup(config, { output, checkpoints: true, includeSecrets: false }, 'test')
    ).rejects.toThrow('overlaps');
  }
);

it.skipIf(process.platform === 'win32')(
  'refuses symlinks at configured roots, including dangling ones',
  async () => {
    const { root, config, output } = await fixture();
    const linkedRoot = join(root, 'linked-images');
    await symlink(config.uploads.dir, linkedRoot, 'dir');
    config.images.dir = linkedRoot;
    await expect(
      captureBackup(config, { output, checkpoints: true, includeSecrets: false }, 'test')
    ).rejects.toThrow('symlink');
    expect(await Bun.file(output).exists()).toBe(false);
    await rm(linkedRoot);
    await symlink(join(root, 'absent-directory'), linkedRoot, 'dir');
    await expect(
      captureBackup(config, { output, checkpoints: true, includeSecrets: false }, 'test')
    ).rejects.toThrow('symlink');
  }
);

for (const suffix of ['/', '/.']) {
  it.skipIf(process.platform === 'win32')(
    `refuses configured-root symlinks with a ${JSON.stringify(suffix)} suffix`,
    async () => {
      const { root, config, output } = await fixture();
      const linkedRoot = join(root, 'linked-images');
      await symlink(config.uploads.dir, linkedRoot, 'dir');
      config.images.dir = `${linkedRoot}${suffix}`;
      await expect(
        captureBackup(config, { output, checkpoints: true, includeSecrets: false }, 'test')
      ).rejects.toThrow('symlink');
      expect(await Bun.file(output).exists()).toBe(false);
      await rm(linkedRoot);
      await symlink(join(root, 'absent-directory'), linkedRoot, 'dir');
      await expect(
        captureBackup(config, { output, checkpoints: true, includeSecrets: false }, 'test')
      ).rejects.toThrow('symlink');
    }
  );
}

it.skipIf(process.platform === 'win32')(
  'refuses parent traversal across an intermediate symlink rather than capturing another root',
  async () => {
    const { root, config, output } = await fixture();
    const lexicalParent = join(root, 'a');
    const physicalParent = join(root, 'b');
    await mkdir(join(lexicalParent, 'images'), { recursive: true });
    await mkdir(join(physicalParent, 'child'), { recursive: true });
    await mkdir(join(physicalParent, 'images'));
    await symlink(join(physicalParent, 'child'), join(lexicalParent, 'link'), 'dir');
    await writeFile(join(physicalParent, 'images', 'sentinel.txt'), 'application reads this root');
    await writeFile(join(lexicalParent, 'images', 'sentinel.txt'), 'wrong lexical root');
    // Keep the parent traversal literal: path.join would erase the scenario.
    config.images.dir = `${lexicalParent}/link/../images`;
    expect(await readFile(`${config.images.dir}/sentinel.txt`, 'utf8')).toBe(
      'application reads this root'
    );
    await expect(
      captureBackup(config, { output, checkpoints: true, includeSecrets: false }, 'test')
    ).rejects.toThrow('parent traversal');
    expect(await Bun.file(output).exists()).toBe(false);
  }
);
