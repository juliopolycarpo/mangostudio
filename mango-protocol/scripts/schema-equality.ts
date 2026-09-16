/**
 * How `verify-schema-equality.ts` compares two emitters against the spec.
 *
 * The rules themselves live in `@mangostudio/protocol/testing`, so a consumer
 * comparing its own emitted schema against this one applies the same ones
 * rather than a copy; this file is the spec-file wiring around them, and
 * re-exports what it uses so a caller needs one import.
 */

import {
  type Definitions,
  normalizeSchema,
  schemaDifferences,
} from '../packages/protocol/src/testing/schema';

export {
  crossFileDefinitions,
  type Definitions,
  isConstTaggedUnion,
  type Json,
  type JsonObject,
  normalizeSchema,
  schemaDifferences,
  stripNullAlternative,
} from '../packages/protocol/src/testing/schema';

/**
 * Compares an emitter's definitions with the spec's. `required` names the keys
 * the emitter must provide; keys it provides beyond those are compared too, and
 * a key the spec does not know is a failure.
 *
 * @example
 * compareDefinitions('typescript', emitted, ['frame'], spec); // [] when equal
 */
export function compareDefinitions(
  label: string,
  emitted: Definitions,
  required: readonly string[],
  spec: Definitions
): string[] {
  const failures = required
    .filter((key) => !(key in emitted))
    .map((key) => `${label}: $defs/${key} is missing`);
  for (const key of Object.keys(emitted)) {
    const expected = spec[key];
    if (expected === undefined) {
      failures.push(`${label}: $defs/${key} is not in the spec`);
      continue;
    }
    const diff = schemaDifferences(
      normalizeSchema(expected, spec),
      normalizeSchema(emitted[key] ?? null, emitted)
    );
    failures.push(...diff.map((line) => `${label}: $defs/${key}${line}`));
  }
  return failures;
}
