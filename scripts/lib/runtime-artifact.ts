import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { RuntimeProfile } from './distribution-manifest';
import { readExecutableHeader } from './executable-header';
import type { BinaryTarget, ReleasePlatformId } from './release-targets';
import { prebuiltRuntimePath, runtimeHeaderProblems, runtimeVersionProblem } from './runtime-build';

export interface RuntimeArtifactIdentity {
  readonly sourceSha: string;
  readonly version: string;
  readonly profile: RuntimeProfile;
}

export interface RuntimeArtifactReceipt extends RuntimeArtifactIdentity {
  readonly schemaVersion: 1;
  readonly target: ReleasePlatformId;
  readonly sha256: string;
  readonly size: number;
  /** Null when the runtime was built on a host that cannot execute it. */
  readonly reportedVersion: string | null;
}

function runtimeReceiptPath(binary: string): string {
  return join(dirname(binary), 'runtime-build.json');
}

function runtimeDigest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Record the identity and bytes of a runtime staged by the build command.
 * @example writeRuntimeArtifactReceipt(outDir, target, identity, verification.reportedVersion);
 */
export function writeRuntimeArtifactReceipt(
  outDir: string,
  target: BinaryTarget,
  identity: RuntimeArtifactIdentity,
  reportedVersion: string | null
): void {
  if (!/^[a-f\d]{40}$/.test(identity.sourceSha)) {
    throw new Error(`expected runtime sourceSha: full Git SHA | received: ${identity.sourceSha}`);
  }
  const versionProblem =
    reportedVersion === null ? null : runtimeVersionProblem(reportedVersion, identity.version);
  if (versionProblem) throw new Error(`${target.arch}: ${versionProblem}`);
  const path = prebuiltRuntimePath(outDir, target);
  const bytes = readFileSync(path);
  const receipt: RuntimeArtifactReceipt = {
    schemaVersion: 1,
    target: target.arch,
    sourceSha: identity.sourceSha,
    version: identity.version,
    profile: identity.profile,
    sha256: runtimeDigest(bytes),
    size: bytes.length,
    reportedVersion: reportedVersion?.trim() ?? null,
  };
  writeFileSync(runtimeReceiptPath(path), `${JSON.stringify(receipt, null, 2)}\n`);
}

/** Verify the runtime receipt, its bytes and executable header against the requested target.
 * @example readRuntimeArtifactReceipt(outDir, target, { sourceSha, version, profile: 'shipping' });
 */
export function readRuntimeArtifactReceipt(
  outDir: string,
  target: BinaryTarget,
  expected: RuntimeArtifactIdentity,
  verifiedReceipt?: string
): RuntimeArtifactReceipt {
  const path = prebuiltRuntimePath(outDir, target);
  const receiptPath = verifiedReceipt ?? runtimeReceiptPath(path);
  const value: unknown = JSON.parse(readFileSync(receiptPath, 'utf8'));
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(
      `expected ${target.arch} runtime receipt object | received: ${JSON.stringify(value)}`
    );
  }
  const row = value as Record<string, unknown>;
  for (const [field, expectedValue] of Object.entries({
    schemaVersion: 1,
    target: target.arch,
    sourceSha: expected.sourceSha,
    version: expected.version,
    profile: expected.profile,
  })) {
    if (row[field] !== expectedValue) {
      throw new Error(
        `expected ${target.arch} runtime ${field}: ${expectedValue} | received: ${String(row[field])}`
      );
    }
  }
  if (row.reportedVersion !== null && row.reportedVersion !== expected.version) {
    const received =
      typeof row.reportedVersion === 'string'
        ? row.reportedVersion
        : JSON.stringify(row.reportedVersion);
    throw new Error(
      `expected ${target.arch} runtime reportedVersion: ${expected.version} or null | received: ${received}`
    );
  }
  const bytes = readFileSync(path);
  const actualSha = runtimeDigest(bytes);
  if (bytes.length === 0 || row.size !== bytes.length || row.sha256 !== actualSha) {
    throw new Error(
      `expected ${target.arch} runtime: ${String(row.size)} bytes SHA256 ${String(row.sha256)} | received: ${bytes.length} bytes SHA256 ${actualSha}`
    );
  }
  const problems = runtimeHeaderProblems(target.arch, readExecutableHeader(bytes), {
    enforceGlibcFloor: true,
  });
  if (problems.length)
    throw new Error(`${target.arch} runtime header failed: ${problems.join('; ')}`);
  return row as unknown as RuntimeArtifactReceipt;
}
