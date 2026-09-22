/**
 * The cross-language description of the hub/runtime boundary, built from the
 * TypeScript that defines it.
 *
 * A runtime that is not a TypeScript module still has to be fully described by
 * files the hub owns. Everything here is derived — no shape is written twice —
 * so the committed artifacts cannot drift from the contract, and the freshness
 * check in `bun run check` is what enforces that.
 *
 * Emission is separated from the CLI that writes or diffs it so the mapping can
 * be tested without touching disk.
 */

import { PINNED_GITHUB_GRAPHQL_DOCUMENTS } from '@mangostudio/shared/github';
import {
  CONSENT_DENIED_KIND,
  HubIdentitySchema,
  RUNTIME_CONTRACT,
  RUNTIME_CONTRACT_EVENTS,
  RUNTIME_CONTRACT_NAME,
  RUNTIME_CONTRACT_VERSION,
  RUNTIME_INSTALL_OUTPUT_TOPIC,
  RUNTIME_PAIRING_TOKEN_PREFIX,
  RUNTIME_SERVICE_ERROR_KINDS,
  RUNTIME_SETUP_PENDING_SIGNATURE,
  RUNTIME_UPDATE_EXIT_CODE,
  RUNTIME_UPDATE_REFUSED,
  RuntimeCapabilityManifestSchema,
} from '@mangostudio/shared/runtime-contract';
import {
  MANGO_HOME_DIR_NAME,
  RUNTIME_AUDIT_LOG_FILE_NAME,
  RUNTIME_BINARY_BASENAME,
  RUNTIME_CONFIG_FILE_NAME,
  RUNTIME_CONFIG_LOCK_FILE_NAME,
  RUNTIME_CREDENTIALS_FILE_NAME,
  RUNTIME_CURRENT_LINK_NAME,
  RUNTIME_HOME_DIR_NAME,
  RUNTIME_SLOTS,
  RuntimeAuditRecordSchema,
  RuntimeHealthReportSchema,
  RuntimeSlotConfigSchema,
  RuntimeSlotCredentialsSchema,
} from '@mangostudio/shared/runtime-home';
import { corpusDocument } from './corpus';

/** Where the committed artifacts live, relative to the repository root. */
export const ARTIFACT_DIR = 'apps/shared/src/runtime-contract/generated';

/** The published catalog schema every emitted catalog has to validate against. */
export const CATALOG_SCHEMA_URL = 'https://mangostudio.dev/protocol/schema/1/catalog.json';

const JSON_SCHEMA_DRAFT = 'https://json-schema.org/draft/2020-12/schema';
const SCHEMA_BASE_URL = 'https://mangostudio.dev/runtime/schema/1';

interface SchemaDocumentOptions {
  readonly id: string;
  readonly title: string;
  readonly description: string;
}

/** Wraps a TypeBox schema as a standalone, self-describing JSON Schema document. */
function schemaDocument(
  schema: object,
  { id, title, description }: SchemaDocumentOptions
): Record<string, unknown> {
  return {
    $schema: JSON_SCHEMA_DRAFT,
    $id: `${SCHEMA_BASE_URL}/${id}`,
    title,
    description,
    ...schema,
  };
}

function catalogDocument(): Record<string, unknown> {
  return { $schema: CATALOG_SCHEMA_URL, ...RUNTIME_CONTRACT.catalog() };
}

function runtimeHomeDocument(): Record<string, unknown> {
  return schemaDocument(
    {
      $defs: {
        slotConfig: RuntimeSlotConfigSchema,
        credentials: RuntimeSlotCredentialsSchema,
        auditRecord: RuntimeAuditRecordSchema,
      },
    },
    {
      id: 'runtime-home.json',
      title: 'MangoStudio runtime home',
      description:
        'What a runtime keeps under its slot directory: runtime.json, credentials.json, and one line of audit.log. The file and directory names these shapes are stored under are in strings.json.',
    }
  );
}

function manifestDocument(): Record<string, unknown> {
  return schemaDocument(
    {
      $defs: { hubIdentity: HubIdentitySchema },
      ...RuntimeCapabilityManifestSchema,
    },
    {
      id: 'manifest.json',
      title: 'MangoStudio runtime capability manifest',
      description:
        'What a runtime announces about itself in hello.capabilities. Open by design: an older hub keeps talking to a newer runtime that advertises extra keys. $defs.hubIdentity is what the hub announces back under capabilities.hub.',
    }
  );
}

function healthDocument(): Record<string, unknown> {
  return schemaDocument(RuntimeHealthReportSchema, {
    id: 'health.json',
    title: 'MangoStudio runtime health report',
    description:
      'What `mangostudio-runtime health --json` prints and what the runtime.health method returns — one payload, so a terminal on the machine and a card in a browser cannot disagree.',
  });
}

function installOutputDocument(): Record<string, unknown> {
  return schemaDocument(RUNTIME_CONTRACT_EVENTS[RUNTIME_INSTALL_OUTPUT_TOPIC].payload, {
    id: 'install-output.json',
    title: 'MangoStudio runtime install output frame',
    description: `One frame on the ${RUNTIME_INSTALL_OUTPUT_TOPIC} topic, keyed by run id. The frame carrying end closes the stream and its line is empty.`,
  });
}

/**
 * The contracts that are values rather than shapes: a string one process greps
 * for in another's stderr, an exit code a supervisor reads, the names a slot
 * directory is laid out with.
 *
 * Nothing derives them, which is exactly why they are emitted — a peer in
 * another language has no way to get them wrong quietly except by typing them
 * again.
 */
function stringsDocument(): Record<string, unknown> {
  return {
    $comment: `Generated from apps/shared/src/runtime-contract. Regenerate with "bun run contracts:emit".`,
    contract: { name: RUNTIME_CONTRACT_NAME, version: RUNTIME_CONTRACT_VERSION },
    topics: Object.keys(RUNTIME_CONTRACT_EVENTS).sort(),
    errors: {
      consentDeniedKind: CONSENT_DENIED_KIND,
      updateRefusedCode: RUNTIME_UPDATE_REFUSED,
      serviceErrorKinds: [...RUNTIME_SERVICE_ERROR_KINDS],
    },
    setupPendingSignature: RUNTIME_SETUP_PENDING_SIGNATURE,
    updateExitCode: RUNTIME_UPDATE_EXIT_CODE,
    pairingTokenPrefix: RUNTIME_PAIRING_TOKEN_PREFIX,
    githubGraphqlDocuments: [...PINNED_GITHUB_GRAPHQL_DOCUMENTS],
    runtimeHome: {
      slots: [...RUNTIME_SLOTS],
      homeDirName: MANGO_HOME_DIR_NAME,
      runtimeDirName: RUNTIME_HOME_DIR_NAME,
      currentLinkName: RUNTIME_CURRENT_LINK_NAME,
      configFileName: RUNTIME_CONFIG_FILE_NAME,
      configLockFileName: RUNTIME_CONFIG_LOCK_FILE_NAME,
      credentialsFileName: RUNTIME_CREDENTIALS_FILE_NAME,
      auditLogFileName: RUNTIME_AUDIT_LOG_FILE_NAME,
      binaryBasename: RUNTIME_BINARY_BASENAME,
    },
  };
}

export interface ContractArtifact {
  readonly name: string;
  readonly build: () => Record<string, unknown>;
}

export const CONTRACT_ARTIFACTS: readonly ContractArtifact[] = [
  { name: 'catalog.json', build: catalogDocument },
  { name: 'runtime-home.schema.json', build: runtimeHomeDocument },
  { name: 'manifest.schema.json', build: manifestDocument },
  { name: 'health.schema.json', build: healthDocument },
  { name: 'install-output.schema.json', build: installOutputDocument },
  { name: 'strings.json', build: stringsDocument },
  { name: 'conformance-corpus.json', build: corpusDocument },
];

/**
 * Renders one artifact exactly as it is committed.
 *
 * Two indented spaces and a trailing newline, so the file reads as a diff and
 * `git` does not report a missing terminator. Byte-stable across runs: TypeBox
 * schemas serialize in declaration order and nothing here iterates a Set.
 *
 * @example
 * const text = renderArtifact(CONTRACT_ARTIFACTS[0]);
 */
export function renderArtifact(artifact: ContractArtifact): string {
  return `${JSON.stringify(artifact.build(), null, 2)}\n`;
}

/** Every artifact's committed path and content, keyed by repository-relative path. */
export function renderArtifacts(): Map<string, string> {
  return new Map(
    CONTRACT_ARTIFACTS.map((artifact) => [
      `${ARTIFACT_DIR}/${artifact.name}`,
      renderArtifact(artifact),
    ])
  );
}
