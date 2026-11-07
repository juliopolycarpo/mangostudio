import { Database } from 'bun:sqlite';
import { constants } from 'node:fs';
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  BACKUP_LIMITS,
  type BackupManifest,
  BackupManifestSchema,
} from '@mangostudio/shared/backup';
import Value from 'typebox/value';

import { getConfigEnvFilePath, type MangoConfig } from '../lib/config';
import { resolvePathThroughExistingAncestor } from '../lib/path-containment';
import { acquireCaptureLock } from './capture-lock';
import { BACKUP_EXCLUSIONS, redactBackupDatabase } from './privacy';
import { protectStaging } from './private-staging';

export const CAPTURE_LIMITS = BACKUP_LIMITS;

export interface CaptureOptions {
  output: string;
  checkpoints: boolean;
  includeSecrets: boolean;
  signal?: AbortSignal;
}

interface Root {
  id: string;
  source: string;
}

/** Resolve only application-owned data, never a whole home or runtime installation. */
export function backupRoots(config: MangoConfig, checkpoints: boolean): Root[] {
  return [
    { id: 'uploads', source: config.uploads.dir },
    { id: 'images', source: config.images.dir },
    { id: 'tool-images', source: config.toolImages.dir },
    { id: 'agents', source: config.agents.dir },
    { id: 'skills', source: config.skills.dir },
    ...(checkpoints ? [{ id: 'checkpoints', source: config.checkpoints.dir }] : []),
  ];
}

function check(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}
function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

async function realpathIfPresent(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Resolve a present path or walk up to its first physically present ancestor. */
async function physicalBackupLocation(source: string): Promise<string> {
  const missing: string[] = [];
  let ancestor = source;
  for (;;) {
    const physical = await realpathIfPresent(ancestor);
    if (physical) return join(physical, ...missing.reverse());

    const entry = await lstat(ancestor).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    const parent = dirname(ancestor);
    if (entry || parent === ancestor) {
      throw new Error('Backup cannot resolve a configured path through its ancestor.');
    }
    missing.push(basename(ancestor));
    ancestor = parent;
  }
}

/** Refuse names that cannot round-trip safely on every supported platform. */
export function portableBackupName(name: string): boolean {
  return (
    name.length > 0 &&
    !/[\\\\/:*?"<>|]/u.test(name) &&
    Array.from(name).every((char) => char.charCodeAt(0) >= 0x20) &&
    !/[. ]$/u.test(name) &&
    !/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(name) &&
    name !== '.' &&
    name !== '..'
  );
}

function excludedName(name: string): boolean {
  // safe-file stages writes beside the destination as .<basename>.<16 hex>.tmp.
  if (/^\..+\.[0-9a-f]{16}\.tmp$/iu.test(name)) return true;
  return /^(?:\.env(?:\..*)?|\.?credentials(?:\..*)?|tokens?(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|auth\.json|.*\.(?:key|pem|p12|pfx)|node_modules|\.git|logs?|cache|audit|run)$/iu.test(
    name
  );
}

/** Copy with bounded reads so a growing source cannot exhaust staging. */
async function copyBounded(
  source: string,
  destination: string,
  maxBytes: number,
  signal?: AbortSignal
): Promise<void> {
  // A regular file from the walk may be replaced by a FIFO before open.
  const input = await open(
    source,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
  );
  try {
    const metadata = await input.stat();
    if (!metadata.isFile()) throw new Error('Backup source is not a regular file.');
    if (metadata.nlink !== 1) throw new Error('Backup refuses multiply linked source files.');
    const output = await open(destination, 'wx', 0o600);
    try {
      const buffer = Buffer.alloc(64 * 1024);
      let total = 0;
      for (;;) {
        check(signal);
        const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        total += bytesRead;
        if (total > maxBytes)
          throw new Error('Backup source exceeds its byte limit during capture.');
        let written = 0;
        while (written < bytesRead) {
          check(signal);
          const { bytesWritten } = await output.write(
            buffer,
            written,
            bytesRead - written,
            total - bytesRead + written
          );
          if (bytesWritten <= 0) throw new Error('Backup file write made no progress.');
          written += bytesWritten;
        }
      }
    } finally {
      await output.close();
    }
  } finally {
    await input.close();
  }
}

/**
 * Capture a stopped Hub's configured roots. The caller must also refuse a live
 * pre-lock Hub. External editors/runtimes must be stopped by the operator.
 */
export async function captureBackup(
  config: MangoConfig,
  options: CaptureOptions,
  version: string,
  hooks: { afterFilesStaged?: () => Promise<void> } = {}
): Promise<BackupManifest> {
  check(options.signal);
  if (config.database.path === ':memory:') throw new Error('Backup requires a persisted database.');
  // Consult the filesystem before simplifying these selectors: lexical '..'
  // removal across a symlink can change the output parent or hide a config
  // file actually inside a data root from the overlap/privacy guard.
  const output = join(await realpath(dirname(options.output)), basename(options.output));
  const occupied = await lstat(output).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (occupied) {
    throw Object.assign(new Error('Backup destination already exists.'), { code: 'EEXIST' });
  }
  const environmentFile = getConfigEnvFilePath(config.configFilePath);
  const fallbackDir = config.secretStore.unsafeFileFallbackDir.trim();
  const configuredPaths = [
    config.configFilePath,
    environmentFile,
    ...(fallbackDir ? [join(fallbackDir, 'secrets.json')] : []),
  ];
  const configurationPath = await physicalBackupLocation(config.configFilePath);
  const managedPaths = new Set([
    configurationPath,
    ...(await Promise.all(configuredPaths.slice(1).map(physicalBackupLocation))),
    // The sync atomic writer follows its own missing-target resolver. Older
    // writes may have put credentials at a different path from filesystem reads.
    ...configuredPaths.map(resolvePathThroughExistingAncestor),
  ]);
  if ([...managedPaths].some((path) => inside(output, path))) {
    throw new Error('Backup destination overlaps a managed configuration or secret path.');
  }
  const databasePath = await realpath(config.database.path);
  const configuredRoots = await Promise.all(
    backupRoots(config, true).map(async (root) => {
      // Collapsing '..' across an earlier symlink can select a different
      // directory from the one the application reads. Refuse that ambiguity.
      const components =
        process.platform === 'win32' ? root.source.split(/[\\/]/u) : root.source.split('/');
      if (components.includes('..')) {
        throw new Error(
          "Backup refuses configured roots containing parent traversal ('..'). Use an explicit directory path without '..' components."
        );
      }
      // Remove lexical trailing separators/dot components before lstat: both
      // "link/" and "link/." otherwise follow the final symlink on POSIX.
      const source = resolve(root.source);
      try {
        // Inspect the configured directory entry before canonicalizing it:
        // realpath alone would hide both live and dangling root symlinks.
        const entry = await lstat(source);
        if (entry.isSymbolicLink()) throw new Error('Backup refuses symlinks at configured roots.');
        if (!entry.isDirectory()) throw new Error('Configured backup roots must be directories.');
        return { ...root, source: await realpath(source), present: true };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
          return { ...root, source, present: false };
        throw error;
      }
    })
  );
  const locations = await Promise.all(
    configuredRoots.map(async (root) => ({
      id: root.id,
      path: root.present ? root.source : await physicalBackupLocation(root.source),
    }))
  );
  for (const [index, root] of locations.entries()) {
    const overlap = locations
      .slice(0, index)
      .find((other) => inside(root.path, other.path) || inside(other.path, root.path));
    if (overlap) {
      throw new Error(`Configured backup roots overlap: ${overlap.id} and ${root.id}.`);
    }
    if (
      inside(root.path, output) ||
      inside(output, root.path) ||
      inside(root.path, databasePath) ||
      inside(root.path, configurationPath)
    ) {
      throw new Error(
        'A data root overlaps the archive, database or configuration; relocate the output or use non-overlapping roots.'
      );
    }
  }
  const resolvedRoots = configuredRoots.filter(
    (root) => options.checkpoints || root.id !== 'checkpoints'
  );
  const release = await acquireCaptureLock(databasePath);
  let staging: string | undefined;
  let source: Database | undefined;
  let published = false;
  let entriesSeen = 0;
  try {
    check(options.signal);
    staging = await mkdtemp(join(dirname(output), '.mango-backup-'));
    await protectStaging(staging);
    if ((await stat(databasePath)).size > CAPTURE_LIMITS.fileBytes)
      throw new Error('Backup database exceeds the file byte limit.');
    source = new Database(databasePath, { create: false });
    source.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');
    const pages = source.query('PRAGMA page_count').get() as { page_count: number };
    const pageSize = source.query('PRAGMA page_size').get() as { page_size: number };
    if (pages.page_count * pageSize.page_size > CAPTURE_LIMITS.fileBytes) {
      throw new Error('Backup database including committed WAL exceeds the file byte limit.');
    }
    // serialize() includes the committed WAL state while the write reservation
    // prevents a concurrent DB writer from changing referenced media rows.
    const serialized = source.serialize();
    if (serialized.byteLength > CAPTURE_LIMITS.fileBytes) {
      throw new Error('Backup database serialized image exceeds the file byte limit.');
    }
    // sqlite3_deserialize cannot reopen an in-memory WAL database. The bytes
    // already contain committed WAL pages; reset only this private image's
    // read/write format header to rollback mode (SQLite deserialize contract).
    serialized[18] = 1;
    serialized[19] = 1;
    const snapshot = Database.deserialize(serialized);
    try {
      redactBackupDatabase(snapshot, options.checkpoints);
      const bytes = snapshot.serialize();
      if (bytes.byteLength > CAPTURE_LIMITS.totalBytes)
        throw new Error('Backup database exceeds the expanded byte limit.');
      await writeFile(join(staging, 'database.sqlite'), bytes, { mode: 0o600 });
    } finally {
      snapshot.close();
    }
    const files: Record<string, Uint8Array> = {};
    const manifest: BackupManifest = {
      format: 'mangostudio-backup',
      schemaVersion: 1,
      compression: 'gzip',
      createdAt: new Date().toISOString(),
      applicationVersion: version,
      consistency: 'stopped-hub-with-database-write-reservation',
      checkpoints: options.checkpoints,
      portableSecrets: options.includeSecrets ? ['hub-auth-secret'] : [],
      exclusions: [...BACKUP_EXCLUSIONS],
      roots: resolvedRoots,
      files: [],
    };
    let totalBytes = 0;
    const fingerprints = new Map<string, string>();
    const fingerprint = async (path: string) => {
      const value = await lstat(path, { bigint: true });
      return `${value.dev}:${value.ino}:${value.mode}:${value.size}:${value.mtimeNs}:${value.ctimeNs}`;
    };
    const add = async (name: string, path: string) => {
      check(options.signal);
      const file = Bun.file(path);
      const size = (await stat(path)).size;
      if (
        size > CAPTURE_LIMITS.fileBytes ||
        totalBytes + size > CAPTURE_LIMITS.totalBytes ||
        manifest.files.length >= CAPTURE_LIMITS.files
      ) {
        throw new Error('Backup exceeds the file, count or expanded byte limit.');
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      totalBytes += size;
      manifest.files.push({
        path: name,
        sizeBytes: size,
        sha256: new Bun.CryptoHasher('sha256').update(bytes).digest('hex'),
      });
      files[name] = bytes;
    };
    await add('database.sqlite', join(staging, 'database.sqlite'));
    // Reconstruct a portable configuration; raw config and .env are never copied.
    await writeFile(
      join(staging, 'config.json'),
      JSON.stringify({
        schemaVersion: 1,
        compression: 'gzip',
        roots: Object.fromEntries(resolvedRoots.map((root) => [root.id, root.id])),
        ...(options.includeSecrets && { auth: { secret: config.auth.secret } }),
      }),
      { mode: 0o600 }
    );
    await add('config.json', join(staging, 'config.json'));
    const walk = async (
      root: string,
      path: string,
      prefix: string,
      depth: number
    ): Promise<void> => {
      check(options.signal);
      if (depth > CAPTURE_LIMITS.depth)
        throw new Error('Backup exceeds the directory depth limit.');
      const meta = await lstat(path);
      if (!meta.isDirectory() && !meta.isFile())
        throw new Error('Backup refuses symlinks and special files.');
      const canonicalPath = await realpath(path);
      if (!inside(root, canonicalPath))
        throw new Error('Backup source escaped its configured root.');
      if (meta.isFile() && managedPaths.has(canonicalPath)) {
        manifest.exclusions.push(prefix);
        return;
      }
      fingerprints.set(path, await fingerprint(path));
      if (meta.isFile()) {
        if (
          meta.size > CAPTURE_LIMITS.fileBytes ||
          totalBytes + meta.size > CAPTURE_LIMITS.totalBytes
        ) {
          throw new Error('Backup exceeds the file or expanded byte limit.');
        }
        const staged = join(staging as string, prefix);
        await mkdir(dirname(staged), { recursive: true, mode: 0o700 });
        await copyBounded(
          path,
          staged,
          Math.min(CAPTURE_LIMITS.fileBytes, CAPTURE_LIMITS.totalBytes - totalBytes),
          options.signal
        );
        await chmod(staged, 0o600);
        await add(prefix, staged);
        return;
      }
      const names: string[] = [];
      const directory = await opendir(path);
      for await (const entry of directory) {
        if (++entriesSeen > CAPTURE_LIMITS.files)
          throw new Error('Backup exceeds the entry count limit.');
        names.push(entry.name);
      }
      const folded = new Set<string>();
      for (const name of names.sort()) {
        if (excludedName(name)) {
          manifest.exclusions.push(`${prefix}/${name}`);
          continue;
        }
        const key = name.normalize('NFC').toLowerCase();
        if (!portableBackupName(name) || folded.has(key))
          throw new Error('Backup source has a non-portable or case-colliding name.');
        folded.add(key);
        await walk(root, join(path, name), `${prefix}/${name}`, depth + 1);
      }
    };
    for (const root of resolvedRoots) {
      if (!root.present) continue;
      if (!(await stat(root.source)).isDirectory())
        throw new Error('Configured backup roots must be directories.');
      await walk(root.source, root.source, root.id, 0);
    }
    await hooks.afterFilesStaged?.();
    for (const root of resolvedRoots.filter((root) => !root.present)) {
      try {
        await lstat(root.source);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      throw new Error('Backup source changed during capture: an absent root appeared.');
    }
    // Fail the entire capture if any observed file/directory changed or disappeared.
    for (const [path, before] of fingerprints) {
      check(options.signal);
      if ((await fingerprint(path)) !== before)
        throw new Error('Backup source changed during capture. Stop external writers and retry.');
    }
    if (!Value.Check(BackupManifestSchema, manifest)) throw new Error('Invalid backup manifest.');
    const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
    if (
      manifestBytes.byteLength > CAPTURE_LIMITS.fileBytes ||
      totalBytes + manifestBytes.byteLength > CAPTURE_LIMITS.totalBytes
    ) {
      throw new Error('Backup manifest exceeds the expanded byte limit.');
    }
    await writeFile(join(staging, 'manifest.json'), manifestBytes, { mode: 0o600 });
    files['manifest.json'] = manifestBytes;
    check(options.signal);
    const archivePath = join(staging, 'archive.tar.gz');
    await Bun.Archive.write(archivePath, files, { compress: 'gzip', level: 6 });
    // Inspect and flush the same opened file, rather than checking a pathname
    // and reopening a potentially different entry. Staging is owner-private;
    // O_NOFOLLOW also refuses a substituted final symlink where supported.
    const archiveHandle = await open(archivePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const archive = await archiveHandle.stat();
      if (!archive.isFile()) throw new Error('Backup archive is not a regular file.');
      if (archive.size > CAPTURE_LIMITS.archiveBytes)
        throw new Error('Backup exceeds the compressed byte limit.');
      check(options.signal);
      await archiveHandle.chmod(0o600);
      await archiveHandle.sync();
    } finally {
      await archiveHandle.close();
    }
    // Same-directory staging guarantees the same filesystem. Once the
    // exclusive link succeeds, the archive is complete and belongs to its caller.
    check(options.signal);
    await link(archivePath, output);
    published = true;
    return manifest;
  } finally {
    const cleanup = async () => {
      try {
        source?.close();
      } finally {
        try {
          if (staging) await rm(staging, { recursive: true, force: true });
        } finally {
          await release();
        }
      }
    };
    if (published) {
      await cleanup().catch((error: unknown) => {
        console.warn('Backup archive was published, but capture cleanup failed.', error);
      });
    } else {
      await cleanup();
    }
  }
}
