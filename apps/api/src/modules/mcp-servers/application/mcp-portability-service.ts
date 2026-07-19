/**
 * Safe MCP configuration portability: stable export, conflict-aware preview,
 * and compensated all-or-nothing apply. Secret values never enter exported or
 * preview response shapes.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { ERROR_CODES } from '@mangostudio/shared/errors';
import type {
  ApplyMcpPortabilityImportBody,
  ExportMcpServersBody,
  ExportMcpServersResponse,
  McpPortabilityApplyResponse,
  McpPortabilityConflictCandidate,
  McpPortabilityConflictKey,
  McpPortabilityDecisionInput,
  McpPortabilityPreviewEntry,
  McpPortabilityPreviewResponse,
  McpPortabilitySecretReference,
  McpPortableDocument,
  McpPortableServer,
  McpPortableServerMetadata,
  McpTransport,
  PreviewMcpPortabilityImportBody,
} from '@mangostudio/shared/mcp';
import { MCP_SERVER_NAME_MAX_LENGTH, MCP_SERVER_SLUG_MAX_LENGTH } from '@mangostudio/shared/mcp';
import type { Kysely } from 'kysely';
import type { Database, McpServerInsert, McpServerSelect } from '../../../db/types';
import { disposeMcpServer } from '../../../services/mcp/connection-manager';
import {
  listMcpHeaderNames,
  persistMcpHeaders,
  removeMcpHeaders,
} from '../../../services/mcp/header-secrets';
import { parseJsonStringArray, parseJsonStringRecord } from '../../../services/mcp/runtime-config';
import {
  listMcpSecretEnvNames,
  persistMcpSecretEnv,
  removeMcpSecretEnv,
} from '../../../services/mcp/stdio-env-secrets';
import { generateId } from '../../../utils/id';
import { McpServerError } from '../domain/mcp-server';
import {
  deleteMcpServerRow,
  insertMcpServerRow,
  listMcpServerRows,
} from '../infrastructure/mcp-server-repository';
import { analyzeMcpHttpUrl, looksCredentialShaped } from './mcp-credential-policy';
import { type ParsedImportEntry, parseMcpImportSource } from './mcp-import-parser';
import { loadMcpImportSource } from './mcp-import-service';
import {
  assertUniquePostApplySlugs,
  findReplacementSlugBlocker,
} from './mcp-portability-slug-validation';

interface NormalizedServer {
  key: string;
  name: string;
  slug: string;
  transport: McpTransport;
  command: string | null;
  args: string[];
  env: Record<string, string>;
  url: string | null;
  enabled: boolean;
  timeoutMs: number | null;
  secretEnvNames: string[];
  headerNames: string[];
  fingerprint: string;
}

interface ExistingServer extends NormalizedServer {
  id: string;
}

interface PortabilityPlanEntry {
  parsed: ParsedImportEntry;
  normalized?: NormalizedServer;
  preview: McpPortabilityPreviewEntry;
}

interface PortabilityPlan {
  entries: PortabilityPlanEntry[];
  existing: ExistingServer[];
  previewToken: string;
  stateHash: string;
}

interface SelectedOperation {
  entry: PortabilityPlanEntry;
  decision: McpPortabilityDecisionInput;
  server: NormalizedServer;
  newId: string;
  replaceId?: string;
  secretEnv: Record<string, string>;
  headers: Record<string, string>;
}

const CONFLICT_KEY_ORDER: readonly McpPortabilityConflictKey[] = [
  'fingerprint',
  'slug',
  'name',
  'url',
  'command-args',
];

export async function exportMcpServers(
  db: Kysely<Database>,
  userId: string,
  body: ExportMcpServersBody
): Promise<ExportMcpServersResponse> {
  const rows = await listMcpServerRows(db, userId);
  const selected = selectExportRows(rows, body);
  assertExportableUrls(selected);
  const normalized = await Promise.all(selected.map((row) => normalizeExistingServer(row)));
  normalized.sort((left, right) => compareText(left.slug, right.slug));

  const mcpServers: Record<string, McpPortableServer> = {};
  const metadata: Record<string, McpPortableServerMetadata> = {};
  for (const server of normalized) {
    mcpServers[server.slug] = toPortableServer(server);
    metadata[server.slug] = {
      name: server.name,
      enabled: server.enabled,
      timeoutMs: server.timeoutMs,
      secretEnvNames: server.secretEnvNames,
      headerNames: server.headerNames,
    };
  }

  const document: McpPortableDocument = {
    version: 1,
    mcpServers,
    'x-mangostudio': { servers: metadata },
  };
  return {
    filename: 'mangostudio-mcp-v1.json',
    content: `${JSON.stringify(document, null, 2)}\n`,
    serverCount: normalized.length,
  };
}

export async function previewMcpPortabilityImport(
  db: Kysely<Database>,
  userId: string,
  body: PreviewMcpPortabilityImportBody
): Promise<McpPortabilityPreviewResponse> {
  const source = loadMcpImportSource(body);
  const plan = await buildPortabilityPlan(db, userId, source);
  return {
    previewToken: plan.previewToken,
    entries: plan.entries.map((entry) => entry.preview),
  };
}

export async function applyMcpPortabilityImport(
  db: Kysely<Database>,
  userId: string,
  body: ApplyMcpPortabilityImportBody
): Promise<McpPortabilityApplyResponse> {
  const source = loadMcpImportSource(body);
  const plan = await buildPortabilityPlan(db, userId, source);
  if (!tokensEqual(plan.previewToken, body.previewToken)) {
    throw stalePreviewError();
  }

  const decisions = validateDecisions(plan.entries, plan.existing, body.decisions);
  const operations = buildSelectedOperations(plan.entries, decisions);
  const stagedIds: string[] = [];

  try {
    for (const operation of operations) {
      stagedIds.push(operation.newId);
      await stageSecrets(operation);
    }

    await db.transaction().execute(async (trx) => {
      const transactionRows = await listMcpServerRows(trx, userId);
      if (hashStateRows(transactionRows) !== plan.stateHash) throw stalePreviewError();

      for (const operation of operations) {
        if (operation.replaceId) {
          await deleteMcpServerRow(trx, userId, operation.replaceId);
        }
      }
      for (const operation of operations) {
        await insertMcpServerRow(trx, toInsertRow(userId, operation.newId, operation.server));
      }
    });
  } catch (error) {
    await Promise.all(stagedIds.map((id) => removeSecretBundles(id)));
    throw error;
  }

  const replacedIds = operations.flatMap((operation) =>
    operation.replaceId ? [operation.replaceId] : []
  );
  await Promise.all(
    replacedIds.map(async (id) => {
      await disposeMcpServer(userId, id);
      await removeSecretBundles(id);
    })
  );

  return summarizeApply(plan.entries, decisions, operations);
}

async function buildPortabilityPlan(
  db: Kysely<Database>,
  userId: string,
  source: string
): Promise<PortabilityPlan> {
  const parsed = parseMcpImportSource(source);
  const rows = await listMcpServerRows(db, userId);
  const existing = await Promise.all(rows.map((row) => normalizeExistingServer(row)));
  const reservedSlugs = new Set(existing.map((server) => server.slug));
  const reservedNames = new Set(existing.map((server) => normalizeName(server.name)));

  for (const entry of parsed) {
    if (entry.body) {
      reservedSlugs.add(entry.body.slug);
      reservedNames.add(normalizeName(entry.body.name));
    }
  }

  const entries = parsed.map((entry) => {
    const normalized = normalizeParsedServer(entry);
    if (!normalized) return invalidPlanEntry(entry);

    const conflicts = findConflicts(normalized, existing);
    const exact = conflicts.some((candidate) => candidate.exact);
    let copyName: string | undefined;
    let copySlug: string | undefined;
    if (conflicts.length > 0 && !exact) {
      const copy = deriveCopyIdentity(normalized, reservedSlugs, reservedNames);
      copyName = copy.name;
      copySlug = copy.slug;
      reservedNames.add(normalizeName(copy.name));
      reservedSlugs.add(copy.slug);
    }

    const allowedDecisions = exact
      ? (['skip'] as const)
      : conflicts.length > 0
        ? (['skip', 'replace', 'copy'] as const)
        : (['add', 'skip'] as const);
    return {
      parsed: entry,
      normalized,
      preview: {
        key: normalized.key,
        name: normalized.name,
        slug: normalized.slug,
        transport: normalized.transport,
        ...(normalized.command !== null && { command: normalized.command }),
        ...(normalized.url !== null && { url: normalized.url }),
        fingerprint: normalized.fingerprint,
        status: 'ready' as const,
        conflicts,
        allowedDecisions: [...allowedDecisions],
        suggestedDecision: exact || conflicts.length > 0 ? ('skip' as const) : ('add' as const),
        ...(copyName !== undefined && { copyName }),
        ...(copySlug !== undefined && { copySlug }),
        secretReferences: sortSecretReferences(entry.secrets.references),
      },
    };
  });

  const stateHash = hashStateRows(rows);
  const previewToken = hashJson({
    sourceHash: hashText(source),
    stateHash,
    entries: entries.map((entry) => entry.preview),
  });
  return { entries, existing, previewToken, stateHash };
}

function invalidPlanEntry(entry: ParsedImportEntry): PortabilityPlanEntry {
  const reason = entry.preview.reason;
  return {
    parsed: entry,
    preview: {
      key: entry.preview.key,
      name: entry.preview.name,
      slug: entry.preview.slug,
      ...(entry.preview.transport !== undefined && { transport: entry.preview.transport }),
      ...(entry.preview.command !== undefined && { command: entry.preview.command }),
      ...(entry.preview.url !== undefined && { url: entry.preview.url }),
      status: 'invalid',
      ...(reason !== undefined && reason !== 'duplicate-slug' && { reason }),
      conflicts: [],
      allowedDecisions: ['skip'],
      suggestedDecision: 'skip',
      secretReferences: [],
    },
  };
}

function normalizeParsedServer(entry: ParsedImportEntry): NormalizedServer | undefined {
  const body = entry.body;
  if (!body || entry.preview.action !== 'create') return undefined;
  const stdio = body.transport === 'stdio';
  const secretEnvNames = stdio
    ? entry.secrets.references
        .filter((reference) => reference.kind === 'env')
        .map((reference) => reference.name)
        .sort()
    : [];
  const headerNames = stdio
    ? []
    : entry.secrets.references
        .filter((reference) => reference.kind === 'header')
        .map((reference) => reference.name)
        .sort();
  return withFingerprint({
    key: entry.preview.key,
    name: body.name.trim(),
    slug: body.slug,
    transport: body.transport,
    command: stdio ? body.command.trim() : null,
    args: stdio ? [...(body.args ?? [])] : [],
    env: stdio ? sortRecord(body.env ?? {}) : {},
    url: stdio ? null : canonicalizeUrl(body.url),
    enabled: body.enabled ?? true,
    timeoutMs: body.timeoutMs ?? null,
    secretEnvNames,
    headerNames,
  });
}

async function normalizeExistingServer(row: McpServerSelect): Promise<ExistingServer> {
  const stdio = row.transport === 'stdio';
  const storedEnv = stdio ? parseJsonStringRecord(row.envJson) : {};
  const { publicEnv, credentialNames } = splitCredentialEnv(storedEnv);
  const analyzedUrl = !stdio && row.url !== null ? analyzeMcpHttpUrl(row.url) : undefined;
  const storedHeaderNames = stdio ? [] : await listMcpHeaderNames(row.id);
  return {
    id: row.id,
    ...withFingerprint({
      key: row.slug,
      name: row.name.trim(),
      slug: row.slug,
      transport: row.transport,
      command: stdio ? (row.command?.trim() ?? null) : null,
      args: stdio ? parseJsonStringArray(row.argsJson) : [],
      env: sortRecord(publicEnv),
      url: analyzedUrl?.normalizedUrl ?? null,
      enabled: row.enabled !== 0,
      timeoutMs: row.timeoutMs,
      secretEnvNames: stdio
        ? [...new Set([...(await listMcpSecretEnvNames(row.id)), ...credentialNames])].sort()
        : [],
      headerNames: stdio
        ? []
        : [
            ...new Set([
              ...storedHeaderNames,
              ...(analyzedUrl?.embeddedAuthorization !== undefined ? ['Authorization'] : []),
            ]),
          ].sort(),
    }),
  };
}

function withFingerprint(server: Omit<NormalizedServer, 'fingerprint'>): NormalizedServer {
  const fingerprint = hashJson({
    name: normalizeName(server.name),
    slug: server.slug,
    transport: server.transport,
    command: server.command,
    args: server.args,
    env: server.env,
    url: server.url,
    enabled: server.enabled,
    timeoutMs: server.timeoutMs,
    secretEnvNames: server.secretEnvNames.map(normalizeSecretName).sort(),
    headerNames: server.headerNames.map(normalizeSecretName).sort(),
  });
  return { ...server, fingerprint };
}

function findConflicts(
  incoming: NormalizedServer,
  existing: ExistingServer[]
): McpPortabilityConflictCandidate[] {
  const candidates: McpPortabilityConflictCandidate[] = [];
  for (const current of existing) {
    const keys: McpPortabilityConflictKey[] = [];
    if (incoming.fingerprint === current.fingerprint) keys.push('fingerprint');
    if (incoming.slug === current.slug) keys.push('slug');
    if (normalizeName(incoming.name) === normalizeName(current.name)) keys.push('name');
    if (incoming.url !== null && incoming.url === current.url) keys.push('url');
    if (
      incoming.transport === 'stdio' &&
      current.transport === 'stdio' &&
      commandArgsKey(incoming) === commandArgsKey(current)
    ) {
      keys.push('command-args');
    }
    if (keys.length === 0) continue;
    const replaceBlockedBySlug = findReplacementSlugBlocker(incoming.slug, current, existing);
    candidates.push({
      serverId: current.id,
      name: current.name,
      slug: current.slug,
      keys: CONFLICT_KEY_ORDER.filter((key) => keys.includes(key)),
      exact: keys.includes('fingerprint'),
      ...(replaceBlockedBySlug !== undefined && { replaceBlockedBySlug }),
    });
  }
  return candidates.sort((left, right) => compareText(left.slug, right.slug));
}

function validateDecisions(
  entries: PortabilityPlanEntry[],
  existing: ExistingServer[],
  decisions: McpPortabilityDecisionInput[]
): Map<string, McpPortabilityDecisionInput> {
  const byKey = new Map<string, McpPortabilityDecisionInput>();
  for (const decision of decisions) {
    if (byKey.has(decision.key)) validationError(`Duplicate decision for "${decision.key}".`);
    byKey.set(decision.key, decision);
  }
  if (byKey.size !== entries.length || entries.some((entry) => !byKey.has(entry.preview.key))) {
    validationError('Apply must include exactly one decision for every preview entry.');
  }

  for (const entry of entries) {
    const decision = byKey.get(entry.preview.key);
    if (!decision || !entry.preview.allowedDecisions.includes(decision.decision)) {
      validationError(`Decision for "${entry.preview.key}" is not allowed by the preview.`);
    }
    if (decision.decision === 'replace') {
      const candidate = entry.preview.conflicts.find(
        (candidate) => candidate.serverId === decision.targetServerId
      );
      if (!decision.targetServerId || !candidate) {
        validationError(
          `Replacement target for "${entry.preview.key}" is not a preview candidate.`
        );
      }
      const target = existing.find((server) => server.id === decision.targetServerId);
      if (!target) {
        validationError(
          `Replacement target for "${entry.preview.key}" is not a preview candidate.`
        );
      }
      const blocker = findReplacementSlugBlocker(entry.preview.slug, target, existing);
      if (blocker) {
        validationError(
          `Replacing "${target.name}" will not free slug "${blocker.slug}", which belongs to "${blocker.holderName}". Replace that server instead, or import as a copy.`
        );
      }
    } else if (decision.targetServerId !== undefined) {
      validationError(`Only replace decisions may include a target server.`);
    }
    assertSecretInputs(entry, decision);
  }

  const replaceIds = decisions.flatMap((decision) =>
    decision.decision === 'replace' && decision.targetServerId ? [decision.targetServerId] : []
  );
  if (new Set(replaceIds).size !== replaceIds.length) {
    validationError('Two imported entries cannot replace the same managed server.');
  }
  assertUniquePostApplySlugs(
    existing,
    entries.flatMap((entry) =>
      entry.normalized
        ? [
            {
              key: entry.preview.key,
              name: entry.preview.name,
              slug: entry.normalized.slug,
              ...(entry.preview.copySlug !== undefined && { copySlug: entry.preview.copySlug }),
            },
          ]
        : []
    ),
    byKey
  );
  return byKey;
}

function assertSecretInputs(
  entry: PortabilityPlanEntry,
  decision: McpPortabilityDecisionInput
): void {
  if (decision.decision === 'skip') return;
  const references = entry.preview.secretReferences;
  const allowedEnv = new Set(
    references.filter((reference) => reference.kind === 'env').map((reference) => reference.name)
  );
  const allowedHeaders = new Set(
    references.filter((reference) => reference.kind === 'header').map((reference) => reference.name)
  );
  for (const name of Object.keys(decision.secretEnv ?? {})) {
    if (!allowedEnv.has(name)) validationError(`Unexpected secret environment name "${name}".`);
  }
  for (const name of Object.keys(decision.headers ?? {})) {
    if (!allowedHeaders.has(name)) validationError(`Unexpected secret header name "${name}".`);
  }
  for (const reference of references) {
    if (!reference.required) continue;
    const value =
      reference.kind === 'env'
        ? decision.secretEnv?.[reference.name]
        : decision.headers?.[reference.name];
    if (!value) validationError(`A value is required for secret name "${reference.name}".`);
  }
}

function buildSelectedOperations(
  entries: PortabilityPlanEntry[],
  decisions: Map<string, McpPortabilityDecisionInput>
): SelectedOperation[] {
  return entries.flatMap((entry) => {
    const decision = decisions.get(entry.preview.key);
    if (!decision || decision.decision === 'skip' || !entry.normalized) return [];
    const server =
      decision.decision === 'copy'
        ? withFingerprint({
            ...entry.normalized,
            name: entry.preview.copyName ?? entry.normalized.name,
            slug: entry.preview.copySlug ?? entry.normalized.slug,
          })
        : entry.normalized;
    return [
      {
        entry,
        decision,
        server,
        newId: generateId(),
        ...(decision.decision === 'replace' && { replaceId: decision.targetServerId }),
        secretEnv: { ...entry.parsed.secrets.secretEnv, ...(decision.secretEnv ?? {}) },
        headers: { ...entry.parsed.secrets.headers, ...(decision.headers ?? {}) },
      },
    ];
  });
}

async function stageSecrets(operation: SelectedOperation): Promise<void> {
  if (operation.server.transport === 'stdio') {
    await persistMcpSecretEnv(operation.newId, operation.secretEnv);
    return;
  }
  await persistMcpHeaders(operation.newId, operation.headers);
}

async function removeSecretBundles(serverId: string): Promise<void> {
  await Promise.all([removeMcpSecretEnv(serverId), removeMcpHeaders(serverId)]);
}

function toInsertRow(userId: string, id: string, server: NormalizedServer): McpServerInsert {
  const now = Date.now();
  return {
    id,
    userId,
    name: server.name,
    slug: server.slug,
    transport: server.transport,
    command: server.command,
    argsJson: JSON.stringify(server.args),
    envJson: JSON.stringify(server.env),
    url: server.url,
    enabled: server.enabled ? 1 : 0,
    timeoutMs: server.timeoutMs,
    createdAt: now,
    updatedAt: now,
  };
}

function summarizeApply(
  entries: PortabilityPlanEntry[],
  decisions: Map<string, McpPortabilityDecisionInput>,
  operations: SelectedOperation[]
): McpPortabilityApplyResponse {
  const operationByKey = new Map(
    operations.map((operation) => [operation.entry.preview.key, operation])
  );
  let added = 0;
  let replaced = 0;
  let copied = 0;
  let skipped = 0;
  let invalid = 0;
  const results = entries.map((entry) => {
    const decision = decisions.get(entry.preview.key)?.decision ?? 'skip';
    if (entry.preview.status === 'invalid') invalid += 1;
    else if (decision === 'add') added += 1;
    else if (decision === 'replace') replaced += 1;
    else if (decision === 'copy') copied += 1;
    else skipped += 1;
    const operation = operationByKey.get(entry.preview.key);
    return {
      key: entry.preview.key,
      decision,
      ...(operation !== undefined && { serverId: operation.newId }),
    };
  });
  return { added, replaced, copied, skipped, invalid, results };
}

function selectExportRows(rows: McpServerSelect[], body: ExportMcpServersBody): McpServerSelect[] {
  if ('all' in body) {
    if (rows.length === 0) validationError('There are no MCP servers to export.');
    return rows;
  }
  const selectedIds = new Set(body.serverIds);
  const selected = rows.filter((row) => selectedIds.has(row.id));
  if (selected.length !== selectedIds.size) {
    throw new McpServerError('One or more MCP servers were not found.', 404, ERROR_CODES.NOT_FOUND);
  }
  return selected;
}

function toPortableServer(server: NormalizedServer): McpPortableServer {
  if (server.transport === 'http') return { type: 'http', url: server.url ?? '' };
  return {
    type: 'stdio',
    command: server.command ?? '',
    ...(server.args.length > 0 && { args: server.args }),
    ...(Object.keys(server.env).length > 0 && { env: server.env }),
  };
}

function deriveCopyIdentity(
  server: NormalizedServer,
  reservedSlugs: Set<string>,
  reservedNames: Set<string>
): { name: string; slug: string } {
  for (let suffix = 1; suffix < 10_000; suffix += 1) {
    const marker = suffix === 1 ? 'copy' : `copy-${suffix}`;
    const nameMarker = suffix === 1 ? ' copy' : ` copy ${suffix}`;
    const slugBudget = MCP_SERVER_SLUG_MAX_LENGTH - marker.length - 1;
    const slugBase = server.slug.slice(0, Math.max(1, slugBudget)).replace(/-+$/, '');
    const slug = `${slugBase}-${marker}`;
    const nameBudget = MCP_SERVER_NAME_MAX_LENGTH - nameMarker.length;
    const name = `${server.name.slice(0, Math.max(1, nameBudget)).trimEnd()}${nameMarker}`;
    if (!reservedSlugs.has(slug) && !reservedNames.has(normalizeName(name))) return { name, slug };
  }
  throw new McpServerError(
    `Cannot derive an available copy name for "${server.slug}".`,
    409,
    ERROR_CODES.CONFLICT
  );
}

function canonicalizeUrl(value: string): string {
  return analyzeMcpHttpUrl(value).normalizedUrl;
}

function splitCredentialEnv(env: Record<string, string>): {
  publicEnv: Record<string, string>;
  credentialNames: string[];
} {
  const publicEnv: Record<string, string> = {};
  const credentialNames: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (looksCredentialShaped(name, value)) credentialNames.push(name);
    else publicEnv[name] = value;
  }
  return { publicEnv, credentialNames: credentialNames.sort() };
}

function assertExportableUrls(rows: McpServerSelect[]): void {
  for (const row of rows) {
    if (row.transport !== 'http' || row.url === null) continue;
    const { credentialQueryNames } = analyzeMcpHttpUrl(row.url);
    if (credentialQueryNames.length === 0) continue;
    validationError(
      `MCP server "${row.slug}" has credential query parameters. Move them to write-only headers before export.`
    );
  }
}

function commandArgsKey(server: Pick<NormalizedServer, 'args' | 'command'>): string {
  return JSON.stringify([server.command, ...server.args]);
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeSecretName(value: string): string {
  return value.trim().toLowerCase();
}

function sortRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => compareText(left, right))
  );
}

function sortSecretReferences(
  references: McpPortabilitySecretReference[]
): McpPortabilitySecretReference[] {
  return [...references].sort((left, right) =>
    compareText(`${left.kind}:${left.name}`, `${right.kind}:${right.name}`)
  );
}

function hashStateRows(rows: McpServerSelect[]): string {
  return hashJson(
    rows
      .map((row) => ({
        id: row.id,
        name: row.name,
        slug: row.slug,
        transport: row.transport,
        command: row.command,
        argsJson: row.argsJson,
        envJson: row.envJson,
        url: row.url,
        enabled: row.enabled,
        timeoutMs: row.timeoutMs,
        updatedAt: row.updatedAt,
      }))
      .sort((left, right) => compareText(left.id, right.id))
  );
}

/** Locale-independent ordering keeps serialized output stable across installations. */
function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function hashText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hashJson(value: unknown): string {
  return hashText(JSON.stringify(value));
}

function tokensEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function stalePreviewError(): McpServerError {
  return new McpServerError(
    'The import source or current MCP configuration changed. Preview the import again.',
    409,
    ERROR_CODES.CONFLICT
  );
}

function validationError(message: string): never {
  throw new McpServerError(message, 422, ERROR_CODES.VALIDATION);
}
