/**
 * Proves the three schema dialects describe the same wire: the normative
 * `spec/schema/1/protocol.json`, the TypeBox emission of the TypeScript SDK and,
 * when Cargo is available, the schemars emission of the Rust crate. Runs inside
 * `bun run check`.
 *
 * Each emission is normalised (the rules live in `schema-equality.ts`), then
 * every `$defs` entry is deep-compared with the spec's entry. A difference is a
 * review flag on the emitter, not on this script: a new normaliser rule is a
 * contract change.
 *
 * @example
 * bun ./scripts/protocol/verify-schema-equality.ts            # spec vs TypeScript vs Rust
 * bun ./scripts/protocol/verify-schema-equality.ts --ts-only  # skip the Rust emission
 */

import {
  CancelFrameSchema,
  CapabilitiesSchema,
  CatalogEventSchema,
  CatalogMethodSchema,
  CatalogSchema,
  CloseCodeSchema,
  CloseFrameSchema,
  ErrorCodeSchema,
  ErrorFrameSchema,
  ErrorPayloadSchema,
  EventFrameSchema,
  FrameSchema,
  HelloFrameSchema,
  IdSchema,
  LimitsSchema,
  MethodSchema,
  PeerInfoSchema,
  PingFrameSchema,
  PongFrameSchema,
  ProtocolVersionSchema,
  RequestFrameSchema,
  ResultFrameSchema,
  TopicSchema,
} from '@mangostudio/protocol';
import catalogSchema from '../../spec/schema/1/catalog.json';
import protocolSchema from '../../spec/schema/1/protocol.json';
import { ROOT_DIR } from '../lib/config';
import {
  compareDefinitions,
  crossFileDefinitions,
  type Definitions,
  type Json,
  type JsonObject,
  normalizeSchema,
  schemaDifferences,
} from './schema-equality';
import { hasCargo, warnNoCargo } from './toolchain';

/** The TypeScript SDK's schemas, keyed like the spec's `$defs`. */
const TYPESCRIPT_DEFINITIONS = JSON.parse(
  JSON.stringify({
    id: IdSchema,
    method: MethodSchema,
    topic: TopicSchema,
    protocolVersion: ProtocolVersionSchema,
    peer: PeerInfoSchema,
    limits: LimitsSchema,
    capabilities: CapabilitiesSchema,
    errorCode: ErrorCodeSchema,
    errorPayload: ErrorPayloadSchema,
    closeCode: CloseCodeSchema,
    hello: HelloFrameSchema,
    req: RequestFrameSchema,
    res: ResultFrameSchema,
    err: ErrorFrameSchema,
    evt: EventFrameSchema,
    cancel: CancelFrameSchema,
    ping: PingFrameSchema,
    pong: PongFrameSchema,
    close: CloseFrameSchema,
    frame: FrameSchema,
  })
) as Definitions;

/** The `$defs` a catalog emission promises, whichever emitter produced it. */
const CATALOG_REQUIRED = ['method', 'event'];

/** The catalog document's `$defs`, keyed like `catalog.json`; the root is compared separately. */
const TYPESCRIPT_CATALOG_DEFINITIONS = JSON.parse(
  JSON.stringify({ method: CatalogMethodSchema, event: CatalogEventSchema })
) as Definitions;

/** The `$defs` the Rust emission promises; scalar aliases are inlined there. */
const RUST_REQUIRED = [
  'protocolVersion',
  'peer',
  'limits',
  'errorPayload',
  'hello',
  'req',
  'res',
  'err',
  'evt',
  'cancel',
  'ping',
  'pong',
  'close',
  'frame',
];

/** Runs one of the crate's emitting examples and parses what it printed. */
async function rustEmission(example: string): Promise<JsonObject> {
  const proc = Bun.spawn(
    ['cargo', 'run', '--quiet', '--locked', '--example', example, '--features', 'schema'],
    { cwd: `${ROOT_DIR}/crates/mango-protocol`, stdout: 'pipe', stderr: 'pipe' }
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`cargo run --example ${example} failed (${code}):\n${stderr}`);
  return JSON.parse(stdout) as JsonObject;
}

/** The frame document the crate emits, as `$defs` keyed like `protocol.json`. */
async function rustDefinitions(): Promise<Definitions> {
  const emitted = await rustEmission('emit_schema');
  const definitions = emitted.$defs;
  if (definitions === undefined) throw new Error('the Rust emission has no $defs member');
  return definitions as Definitions;
}

/** The catalog document the crate emits, split into its root and its `$defs`. */
async function rustCatalog(): Promise<CatalogDocument> {
  const emitted = await rustEmission('emit_catalog_schema');
  const { $defs, ...root } = emitted;
  if ($defs === undefined) throw new Error('the Rust catalog emission has no $defs member');
  return { root, definitions: $defs as Definitions };
}

/** One emitter's catalog document: the root object, and the `$defs` it references. */
interface CatalogDocument {
  readonly root: JsonObject;
  readonly definitions: Definitions;
}

const spec = protocolSchema.$defs as Record<string, Json>;

/** `catalog.json` split the way an emission is, with its cross-file references resolvable. */
const { $defs: catalogDefs, ...catalogRoot } = catalogSchema as { $defs: Definitions } & JsonObject;

/**
 * Frame definitions a catalog emission may key into its own `$defs` under a
 * bare name: `catalog.protocol` is the one member whose type lives in
 * `protocol.json`, and schemars names it there. The rest of the frame document
 * stays out on purpose, so an emission that leaked a frame definition into the
 * catalog is still reported as "not in the spec" rather than quietly compared
 * against the frame entry of the same name.
 */
const CATALOG_SHARED = ['protocolVersion'];

// `method` is a name pattern in protocol.json and an object in catalog.json, so
// the catalog's own entry has to win: the cross-file keys carry the other one.
const CATALOG_SPEC: Definitions = {
  ...Object.fromEntries(CATALOG_SHARED.map((key) => [key, spec[key] ?? null])),
  ...catalogDefs,
  ...crossFileDefinitions('protocol.json', spec),
};

const failures = compareDefinitions('typescript', TYPESCRIPT_DEFINITIONS, Object.keys(spec), spec);
failures.push(
  ...compareCatalog('typescript catalog', {
    root: JSON.parse(JSON.stringify(CatalogSchema)) as JsonObject,
    definitions: TYPESCRIPT_CATALOG_DEFINITIONS,
  })
);
const compared = ['typescript'];

/**
 * Compares one emitter's catalog document with `catalog.json`: its `$defs`
 * first, then the root object, which no `$defs` entry of either file covers.
 */
function compareCatalog(label: string, emitted: CatalogDocument): string[] {
  const result = compareDefinitions(label, emitted.definitions, CATALOG_REQUIRED, CATALOG_SPEC);
  const diff = schemaDifferences(
    normalizeSchema(catalogRoot as Json, CATALOG_SPEC),
    normalizeSchema(emitted.root, emitted.definitions)
  );
  return [...result, ...diff.map((line) => `${label}: root${line}`)];
}

if (!process.argv.slice(2).includes('--ts-only')) {
  if (hasCargo()) {
    failures.push(...compareDefinitions('rust', await rustDefinitions(), RUST_REQUIRED, spec));
    failures.push(...compareCatalog('rust catalog', await rustCatalog()));
    compared.push('rust');
  } else {
    warnNoCargo();
  }
}

if (failures.length > 0) {
  console.error(`schema equality failed (${failures.length}):`);
  for (const line of failures) console.error(`  ${line}`);
  process.exit(1);
}
console.log(`schema equality: protocol.json and catalog.json == ${compared.join(' == ')}`);
