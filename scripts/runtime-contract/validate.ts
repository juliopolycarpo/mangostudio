/**
 * Validates the emitted catalog against the protocol's own published schema.
 *
 * The byte comparison in `emit.ts --check` answers "did somebody edit the
 * generated file", not "is the generated file correct" — a catalog that breaks
 * the protocol's grammar is byte-stable too, and the first thing to notice
 * would be a peer in another language failing to parse it. So the schema is
 * read from `spec/schema/1/`, the normative documents the protocol package
 * publishes verbatim under `@mangostudio/protocol/schema/1/` and a peer fetches
 * from the published URL, and applied on every run of either mode. The spec
 * files are read rather than the package subpath because the package copies
 * them in at build time: on a clean checkout the copy does not exist yet, and
 * nothing in the workspace graph builds it.
 *
 * ajv rather than TypeBox here on purpose: the published document is plain JSON
 * Schema 2020-12 with a `$ref` across files, and re-expressing it as TypeBox to
 * avoid one dependency would be re-deriving the thing being checked against.
 */

import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020';
import { ARTIFACT_DIR, CATALOG_SCHEMA_URL } from './artifacts';

const CATALOG_ARTIFACT = `${ARTIFACT_DIR}/catalog.json`;

/**
 * Compiles the catalog schema with its cross-file `$ref` resolved.
 *
 * `catalog.json` references `protocol.json#/$defs/protocolVersion` by relative
 * path, so both documents are registered under their own `$id` before
 * compiling; ajv then resolves the reference without reaching the network.
 */
async function compileCatalogValidator(): Promise<ValidateFunction> {
  const [catalog, protocol] = await Promise.all([
    import('../../spec/schema/1/catalog.json', { with: { type: 'json' } }),
    import('../../spec/schema/1/protocol.json', { with: { type: 'json' } }),
  ]);
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  ajv.addSchema(protocol.default);
  ajv.addSchema(catalog.default);
  const validate = ajv.getSchema(CATALOG_SCHEMA_URL);
  if (!validate) {
    throw new Error(
      `spec/schema/1/ declares no schema with $id ${CATALOG_SCHEMA_URL}; received ids: ${Object.keys(ajv.schemas).join(', ')}.`
    );
  }
  return validate;
}

/**
 * Throws when the rendered catalog does not satisfy the published schema,
 * naming the member that failed.
 *
 * @example
 * await assertCatalogValid(renderArtifacts());
 */
export async function assertCatalogValid(artifacts: ReadonlyMap<string, string>): Promise<void> {
  const rendered = artifacts.get(CATALOG_ARTIFACT);
  if (rendered === undefined) {
    throw new Error(
      `No catalog to validate; expected "${CATALOG_ARTIFACT}" among ${[...artifacts.keys()].join(', ')}.`
    );
  }

  const validate = await compileCatalogValidator();
  if (validate(JSON.parse(rendered))) return;

  const failures = (validate.errors ?? [])
    .map((entry) => `  - ${entry.instancePath || '/'}: ${entry.message}`)
    .join('\n');
  throw new Error(
    `The runtime catalog does not validate against ${CATALOG_SCHEMA_URL}:\n${failures}`
  );
}
