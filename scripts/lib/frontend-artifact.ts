import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import Type, { type Static } from 'typebox';
import Value from 'typebox/value';

const SHA = Type.String({ pattern: '^[a-f0-9]{40}$' });
const DIGEST = Type.String({ pattern: '^[a-f0-9]{64}$' });
const EnvironmentSchema = Type.Object(
  { MANGO_API_URL: Type.String(), VITE_API_URL: Type.String() },
  { additionalProperties: false }
);
const IdentitySchema = Type.Object(
  { sourceSha: SHA, bunRevision: SHA, lockfileSha256: DIGEST, environment: EnvironmentSchema },
  { additionalProperties: false }
);
const FrontendArtifactSchema = Type.Object(
  {
    kind: Type.Literal('mangostudio.frontend-artifact'),
    schemaVersion: Type.Literal(1),
    identity: IdentitySchema,
    files: Type.Array(
      Type.Object(
        { path: Type.String({ minLength: 1 }), sha256: DIGEST },
        { additionalProperties: false }
      ),
      { minItems: 4, maxItems: 10000 }
    ),
  },
  { additionalProperties: false }
);

export type FrontendArtifactIdentity = Static<typeof IdentitySchema>;
export type FrontendArtifact = Static<typeof FrontendArtifactSchema>;
export const FRONTEND_ARTIFACT_FILE = '.mango/frontend-artifact.json';
const DIST = 'apps/frontend/dist';
const METAFILE = 'apps/frontend/dist-metafile.json';

/** Capture both accepted build URL inputs, including an unset value. @example frontendBuildEnvironment(process.env); */
export function frontendBuildEnvironment(environment: Record<string, string | undefined>) {
  return {
    MANGO_API_URL: environment.MANGO_API_URL ?? '',
    VITE_API_URL: environment.VITE_API_URL ?? '',
  };
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function inventory(root: string): FrontendArtifact['files'] {
  const files: FrontendArtifact['files'] = [];
  const visit = (path: string): void => {
    const info = lstatSync(join(root, path));
    if (info.isDirectory()) {
      for (const name of readdirSync(join(root, path)).sort()) visit(`${path}/${name}`);
    } else if (info.isFile()) {
      files.push({ path, sha256: digest(readFileSync(join(root, path))) });
    } else {
      throw new Error(
        `frontend ${path}: expected regular file or directory; received special file`
      );
    }
  };
  visit(DIST);
  visit(METAFILE);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function assertBuildInfo(root: string, identity: FrontendArtifactIdentity): void {
  const value: unknown = JSON.parse(readFileSync(join(root, DIST, 'build-info.json'), 'utf8'));
  const info = value as Record<string, unknown> | null;
  if (
    !info ||
    typeof info !== 'object' ||
    info.gitSha !== identity.sourceSha.slice(0, 12) ||
    info.gitDirty !== false ||
    info.buildType !== 'production' ||
    typeof info.builtAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(info.builtAt) ||
    !Number.isFinite(Date.parse(info.builtAt)) ||
    new Date(info.builtAt).toISOString() !== info.builtAt
  ) {
    throw new Error(
      `frontend build-info: expected clean production ${identity.sourceSha.slice(0, 12)} with canonical timestamp; received ${JSON.stringify(value)}`
    );
  }
  // The producer must carry the diagnostic for these exact outputs. A missing
  // or malformed metafile cannot silently disable QA's duplicate-module check.
  const metafile: unknown = JSON.parse(readFileSync(join(root, METAFILE), 'utf8'));
  if (
    !metafile ||
    typeof metafile !== 'object' ||
    !('outputs' in metafile) ||
    !metafile.outputs ||
    typeof metafile.outputs !== 'object' ||
    Array.isArray(metafile.outputs) ||
    Object.keys(metafile.outputs).length === 0
  ) {
    throw new Error('frontend metafile: expected nonempty outputs object');
  }
  for (const [path, output] of Object.entries(metafile.outputs)) {
    const normalized = path.replaceAll('\\', '/');
    const marker = normalized.lastIndexOf('/assets/');
    const asset = marker >= 0 ? normalized.slice(marker + 1) : normalized;
    if (
      !asset.startsWith('assets/') ||
      asset.split('/').some((part) => !part || part === '.' || part === '..')
    ) {
      throw new Error(`frontend metafile output ${path}: expected an assets/ output path`);
    }
    const bytes = readFileSync(join(root, DIST, asset)).byteLength;
    if (!output || typeof output !== 'object' || !('bytes' in output) || output.bytes !== bytes) {
      throw new Error(
        `frontend metafile output ${path}: expected ${bytes} bytes from the matching dist asset; received ${JSON.stringify(output)}`
      );
    }
  }
}

/** Record a clean production output and its required metafile. @example createFrontendArtifact(root, identity); */
export function createFrontendArtifact(
  root: string,
  identity: FrontendArtifactIdentity
): FrontendArtifact {
  if (!Value.Check(IdentitySchema, identity)) {
    throw new Error(
      `frontend identity: expected source/Bun SHA, lock digest and URL inputs; received ${JSON.stringify(identity)}`
    );
  }
  assertBuildInfo(root, identity);
  const files = inventory(root);
  for (const path of [`${DIST}/index.html`, `${DIST}/build-info.json`, METAFILE]) {
    if (!files.some((entry) => entry.path === path)) {
      throw new Error(`frontend inventory: expected required output ${path}`);
    }
  }
  if (!files.some((entry) => entry.path.startsWith(`${DIST}/`) && entry.path.endsWith('.js'))) {
    throw new Error('frontend inventory: expected at least one production JavaScript asset');
  }
  return { kind: 'mangostudio.frontend-artifact', schemaVersion: 1, identity, files };
}

/** Reject stale, mixed, incomplete or differently configured frontend outputs. @example verifyFrontendArtifact(root, JSON.parse(text), identity); */
export function verifyFrontendArtifact(
  root: string,
  value: unknown,
  expected: FrontendArtifactIdentity
): FrontendArtifact {
  if (!Value.Check(FrontendArtifactSchema, value)) {
    throw new Error('frontend artifact: expected version 1 identity and bounded file digests');
  }
  for (const field of ['sourceSha', 'bunRevision', 'lockfileSha256', 'environment'] as const) {
    if (JSON.stringify(value.identity[field]) !== JSON.stringify(expected[field])) {
      throw new Error(
        `frontend ${field}: expected ${JSON.stringify(expected[field])}; received ${JSON.stringify(value.identity[field])}`
      );
    }
  }
  const current = createFrontendArtifact(root, expected);
  if (JSON.stringify(value.files) !== JSON.stringify(current.files)) {
    throw new Error(
      'frontend output: expected exact producer inventory and SHA-256 digests; received missing, extra or changed files'
    );
  }
  return value;
}
