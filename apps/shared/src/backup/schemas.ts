import Type, { type Static } from 'typebox';

export const BACKUP_LIMITS = {
  files: 10_000,
  fileBytes: 32 * 1024 * 1024,
  totalBytes: 128 * 1024 * 1024,
  archiveBytes: 140 * 1024 * 1024,
  depth: 32,
} as const;

/** Portable user-data archive contract. Files are regular tar members only. */
export const BackupManifestSchema = Type.Object({
  format: Type.Literal('mangostudio-backup'),
  schemaVersion: Type.Literal(1),
  compression: Type.Literal('gzip'),
  createdAt: Type.String(),
  applicationVersion: Type.String(),
  consistency: Type.Literal('stopped-hub-with-database-write-reservation'),
  checkpoints: Type.Boolean(),
  portableSecrets: Type.Array(Type.Literal('hub-auth-secret')),
  exclusions: Type.Array(Type.String()),
  roots: Type.Array(
    Type.Object({ id: Type.String(), source: Type.String(), present: Type.Boolean() })
  ),
  files: Type.Array(
    Type.Object({
      path: Type.String({ minLength: 1 }),
      sizeBytes: Type.Integer({ minimum: 0, maximum: BACKUP_LIMITS.fileBytes }),
      sha256: Type.String({ pattern: '^[a-f0-9]{64}$' }),
    }),
    { minItems: 2, maxItems: BACKUP_LIMITS.files }
  ),
});
export type BackupManifest = Static<typeof BackupManifestSchema>;
