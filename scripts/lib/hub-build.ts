import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { type BinaryCompilerMode, parseBinaryCompilerMode } from './build';
import { readExecutableHeader } from './executable-header';
import { ALL_BINARY_TARGETS, type ReleasePlatformId, runtimeBinaryName } from './release-targets';
import { runtimeHeaderProblems } from './runtime-build';

export interface HubBuildRecord {
  readonly schemaVersion: 1;
  readonly target: ReleasePlatformId;
  readonly compilerMode: BinaryCompilerMode;
  readonly compilerVersion: string;
  readonly compilerRevision: string;
  readonly compilerSha256: string;
  readonly sourceSha: string;
  readonly gitDirty: boolean | 'unknown';
  readonly version: string;
  readonly buildType: string;
  readonly builtAt: string;
  readonly hubSha256: string;
  readonly hubSize: number;
  readonly runtimeSha256: string;
  readonly runtimeSize: number;
}

/**
 * Read an immutable native-producer receipt, rejecting malformed identities.
 * @example parseHubBuildRecord(JSON.parse(text))
 */
export function parseHubBuildRecord(value: unknown): HubBuildRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`expected hub build record object | received: ${JSON.stringify(value)}`);
  }
  const row = value as Record<string, unknown>;
  if (row.schemaVersion !== 1) {
    throw new Error(`expected hub build schemaVersion: 1 | received: ${String(row.schemaVersion)}`);
  }
  const target = ALL_BINARY_TARGETS.find((candidate) => candidate.arch === row.target);
  if (!target) {
    throw new Error(
      `expected hub build target: release platform | received: ${String(row.target)}`
    );
  }
  if (row.compilerMode === undefined) {
    throw new Error('expected hub build compilerMode: native | bytecode | received: undefined');
  }
  const compilerMode = parseBinaryCompilerMode(row.compilerMode);
  for (const field of ['compilerSha256', 'hubSha256', 'runtimeSha256'] as const) {
    if (typeof row[field] !== 'string' || !/^[a-f\d]{64}$/.test(row[field])) {
      throw new Error(`expected hub build ${field}: SHA256 | received: ${String(row[field])}`);
    }
  }
  if (typeof row.compilerRevision !== 'string' || !/^[a-f\d]{40}$/.test(row.compilerRevision)) {
    throw new Error(
      `expected hub build compilerRevision: full Bun revision | received: ${String(row.compilerRevision)}`
    );
  }
  if (typeof row.sourceSha !== 'string' || !/^(?:[a-f\d]{40}|unknown)$/.test(row.sourceSha)) {
    throw new Error(
      `expected hub build sourceSha: full Git SHA or unknown | received: ${String(row.sourceSha)}`
    );
  }
  if (typeof row.gitDirty !== 'boolean' && row.gitDirty !== 'unknown') {
    throw new Error(
      `expected hub build gitDirty: boolean or unknown | received: ${String(row.gitDirty)}`
    );
  }
  for (const field of ['compilerVersion', 'version', 'buildType'] as const) {
    if (typeof row[field] !== 'string' || row[field].length === 0) {
      throw new Error(
        `expected hub build ${field}: nonempty string | received: ${String(row[field])}`
      );
    }
  }
  if (
    typeof row.builtAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(row.builtAt) ||
    !Number.isFinite(Date.parse(row.builtAt))
  ) {
    throw new Error(
      `expected hub build builtAt: ISO date string | received: ${String(row.builtAt)}`
    );
  }
  for (const field of ['hubSize', 'runtimeSize'] as const) {
    if (typeof row[field] !== 'number' || !Number.isSafeInteger(row[field]) || row[field] <= 0) {
      throw new Error(
        `expected hub build ${field}: positive integer | received: ${String(row[field])}`
      );
    }
  }
  return { ...row, target: target.arch, compilerMode } as unknown as HubBuildRecord;
}

/** Forget a previous target receipt before replacing either binary. @example discardHubBuildRecord(root, 'linux-x64') */
export function discardHubBuildRecord(rootDir: string, target: ReleasePlatformId): void {
  rmSync(join(rootDir, '.mango/hub-builds', `${target}.json`), { force: true });
}

/**
 * Bind the completed hub/runtime pair to its compiler and source identities.
 * @example writeHubBuildRecord(root, { target, compilerMode: 'native', sourceSha, version, buildType, builtAt })
 */
export function writeHubBuildRecord(
  rootDir: string,
  options: Pick<
    HubBuildRecord,
    'target' | 'compilerMode' | 'sourceSha' | 'gitDirty' | 'version' | 'buildType' | 'builtAt'
  >
): HubBuildRecord {
  const target = ALL_BINARY_TARGETS.find((candidate) => candidate.arch === options.target);
  if (!target) throw new Error(`expected release target | received: ${options.target}`);
  const directory = join(rootDir, '.mango/out', target.arch);
  const hub = readFileSync(join(directory, target.name));
  const runtime = readFileSync(join(directory, runtimeBinaryName(target.name)));
  const problems = runtimeHeaderProblems(target.arch, readExecutableHeader(hub), {
    enforceGlibcFloor: true,
    muslLinkage: 'loader-or-static',
  });
  if (problems.length) throw new Error(`Hub ${target.arch} header failed: ${problems.join('; ')}`);
  const record = parseHubBuildRecord({
    schemaVersion: 1,
    ...options,
    compilerVersion: Bun.version,
    compilerRevision: Bun.revision,
    compilerSha256: createHash('sha256').update(readFileSync(process.execPath)).digest('hex'),
    hubSha256: createHash('sha256').update(hub).digest('hex'),
    hubSize: hub.length,
    runtimeSha256: createHash('sha256').update(runtime).digest('hex'),
    runtimeSize: runtime.length,
  });
  const recordsDir = join(rootDir, '.mango/hub-builds');
  mkdirSync(recordsDir, { recursive: true });
  writeFileSync(join(recordsDir, `${target.arch}.json`), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

/**
 * Load present target receipts and verify their bytes before trusting provenance.
 * @example const records = readHubBuildRecords(root)
 */
export function readHubBuildRecords(rootDir: string): HubBuildRecord[] {
  const records: HubBuildRecord[] = [];
  for (const target of ALL_BINARY_TARGETS) {
    const path = join(rootDir, '.mango/hub-builds', `${target.arch}.json`);
    if (!existsSync(path)) continue;
    const record = parseHubBuildRecord(JSON.parse(readFileSync(path, 'utf8')));
    if (record.target !== target.arch) {
      throw new Error(`expected hub build target: ${target.arch} | received: ${record.target}`);
    }
    const directory = join(rootDir, '.mango/out', target.arch);
    for (const [name, expectedSize, expectedSha] of [
      [target.name, record.hubSize, record.hubSha256],
      [runtimeBinaryName(target.name), record.runtimeSize, record.runtimeSha256],
    ] as const) {
      const bytes = readFileSync(join(directory, name));
      const sha = createHash('sha256').update(bytes).digest('hex');
      if (bytes.length !== expectedSize || sha !== expectedSha) {
        throw new Error(
          `expected ${target.arch}/${name}: ${expectedSize} bytes SHA256 ${expectedSha} | received: ${bytes.length} bytes SHA256 ${sha}`
        );
      }
      const problems = runtimeHeaderProblems(target.arch, readExecutableHeader(bytes), {
        enforceGlibcFloor: true,
        muslLinkage: name === target.name ? 'loader-or-static' : 'static',
      });
      if (problems.length)
        throw new Error(`${target.arch}/${name} header failed: ${problems.join('; ')}`);
    }
    records.push(record);
  }
  return records;
}

/**
 * Require one production native artifact per shipping target before packaging.
 * @example validateNativeHubSet(records, { sourceSha, version })
 */
export function validateNativeHubSet(
  records: readonly HubBuildRecord[],
  expected: { readonly sourceSha: string; readonly version: string }
): void {
  const targets = new Set(records.map((record) => record.target));
  if (records.length !== ALL_BINARY_TARGETS.length || targets.size !== ALL_BINARY_TARGETS.length) {
    throw new Error(
      `expected ${ALL_BINARY_TARGETS.length} distinct native hub targets | received: ${records.length} records, ${targets.size} targets`
    );
  }
  for (const record of records) {
    const fields = {
      compilerMode: 'native',
      buildType: 'production',
      gitDirty: false,
      sourceSha: expected.sourceSha,
      version: expected.version,
      builtAt: records[0].builtAt,
    } as const;
    for (const [field, value] of Object.entries(fields)) {
      if (record[field as keyof HubBuildRecord] !== value) {
        throw new Error(
          `expected ${record.target} ${field}: ${String(value)} | received: ${String(record[field as keyof HubBuildRecord])}`
        );
      }
    }
  }
}
