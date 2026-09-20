/**
 * The behavioural equality gate between the TypeScript contract and any
 * non-TypeScript peer built from `catalog.json`.
 *
 * `catalog.json` proves the two sides read the same JSON Schema text — which
 * is true by construction, since the Rust crate embeds the file rather than
 * copying it, and proves nothing about whether a Rust JSON Schema validator
 * agrees with TypeBox on what that text means. This module builds the corpus
 * that answers that question: one valid seed per method/topic shape, plus a
 * bounded set of mechanical mutations, each carrying the verdict TypeBox
 * itself gives it. A peer's own validator is conformant exactly when it
 * reproduces every verdict in this file.
 *
 * Seeds come from `Value.Create`, which throws rather than guess wherever a
 * schema pins a string to a `pattern`/`format` or an array to `uniqueItems`
 * without a `default` — TypeBox cannot invent a value satisfying an arbitrary
 * pattern, and won't gamble on generating unique items either. `createSeed`
 * below is the narrow, reviewed fallback for exactly those two cases; it
 * refuses to guess too, and throws naming the subject and the offending
 * schema rather than silently drop it from the corpus.
 */

import { RUNTIME_CONTRACT } from '@mangostudio/shared/runtime-contract';
import type { TSchema } from 'typebox';
import Value from 'typebox/value';

/**
 * Thrown by {@link patternSeed} and {@link manualCreate} for the specific shapes that are
 * unsatisfiable outright — an unrecognised `pattern`, or a `uniqueItems` array needing more
 * distinct items than the repair can invent — as opposed to a schema shape `manualCreate`
 * simply does not recognise as one of the ones it repairs. The distinction matters inside an
 * `anyOf`: a branch `manualCreate` does not recognise just is not this branch, so the loop
 * tries the next one; a `CorpusSeedError` means the corpus generator itself needs a fix, and
 * must not be swallowed by that same fallback.
 */
class CorpusSeedError extends Error {}

/** Which side of a method a fixture exercises, or the whole payload of a topic. */
type CorpusSide = 'params' | 'result';

/** Names the schema a fixture was generated from, in a shape a Rust reader indexes by. */
export interface CorpusSubject {
  readonly kind: 'method' | 'topic';
  readonly name: string;
  readonly side?: CorpusSide;
}

/** The five mechanical mutation families, plus the unmutated seed itself. */
type CorpusMutation =
  | 'seed'
  | `drop:${string}`
  | `wrongType:${string}`
  | 'extraProperty'
  | `outOfRange:${string}`
  | `wrongConst:${string}`;

/** One corpus entry: a value, why it exists, and TypeBox's own verdict on it. */
export interface CorpusFixture {
  readonly subject: CorpusSubject;
  readonly mutation: CorpusMutation;
  readonly value: unknown;
  readonly expect: 'valid' | 'invalid';
}

const subjectKey = (subject: CorpusSubject): string =>
  `${subject.kind}:${subject.name}${subject.side ? `:${subject.side}` : ''}`;

/**
 * A value matching `pattern`, for the handful of regexes this contract
 * actually uses. Deliberately closed: an unrecognised pattern throws rather
 * than guess wrong and hand the corpus a seed that fails its own schema.
 */
function patternSeed(pattern: string): string {
  switch (pattern) {
    // `library.*`'s ref slug: dot-separated segments of letters, digits, `_`, `-`.
    case '^[A-Za-z0-9_-]+(?:\\.[A-Za-z0-9_-]+)*$':
      return 'seed-slug';
    // `library.*`'s `environmentId`: lowercase kebab-case.
    case '^[a-z0-9]+(?:-[a-z0-9]+)*$':
      return 'seed-id';
    // `runtime.health`'s `digest`.
    case '^sha256:[a-f0-9]{64}$':
      return `sha256:${'0'.repeat(64)}`;
    default:
      throw new CorpusSeedError(
        `runtime-contract corpus: no seed generator for pattern ${JSON.stringify(pattern)}. ` +
          'Add one to patternSeed() in scripts/runtime-contract/corpus.ts.'
      );
  }
}

/**
 * Builds a value for `schema` by hand, for the two shapes `Value.Create`
 * refuses to guess at: a `pattern`-constrained string, and a `uniqueItems`
 * array. Recurses through `object`, `array` and `anyOf` so the one offending
 * leaf is the only thing this function invents — everything else still comes
 * from `Value.Create`, called per-property so the rest of a seed keeps
 * TypeBox's own defaults.
 *
 * Only ever invoked when `Value.Create(schema)` already threw (see
 * {@link createSeed}), so a schema that needs no repair never reaches here.
 */
function manualCreate(schema: TSchema): unknown {
  const asRecord = schema as unknown as Record<string, unknown>;

  if (asRecord.type === 'string' && typeof asRecord.pattern === 'string') {
    return patternSeed(asRecord.pattern);
  }

  if (asRecord.type === 'object' && asRecord.properties) {
    const properties = asRecord.properties as Record<string, TSchema>;
    const required = (asRecord.required as readonly string[] | undefined) ?? [];
    const result: Record<string, unknown> = {};
    for (const key of required) result[key] = createSeed(properties[key]);
    return result;
  }

  if (asRecord.type === 'array' && asRecord.uniqueItems === true) {
    const minItems = (asRecord.minItems as number | undefined) ?? 0;
    if (minItems > 1) {
      throw new CorpusSeedError(
        `runtime-contract corpus: a uniqueItems array needs ${minItems} distinct items and ` +
          'manualCreate() only ever invents one. Extend manualCreate() in ' +
          'scripts/runtime-contract/corpus.ts.'
      );
    }
    return minItems === 1 ? [createSeed(asRecord.items as TSchema)] : [];
  }

  if (Array.isArray(asRecord.anyOf)) {
    for (const branch of asRecord.anyOf as TSchema[]) {
      try {
        return createSeed(branch);
      } catch (cause) {
        // A `CorpusSeedError` means a leaf is unsatisfiable outright, not that this branch
        // was merely the wrong one — that must reach the caller, not fall through to the
        // next branch and hand the corpus a degenerate seed from an unrelated shape.
        if (cause instanceof CorpusSeedError) throw cause;
        // Not this branch — try the next one.
      }
    }
  }

  throw new Error(
    `runtime-contract corpus: manualCreate() does not know how to repair ${JSON.stringify(schema)}.`
  );
}

/**
 * A value satisfying `schema`, preferring TypeBox's own `Value.Create` and
 * falling back to {@link manualCreate} only for the leaf that made it throw.
 */
function createSeed(schema: TSchema): unknown {
  try {
    return Value.Create(schema);
  } catch {
    return manualCreate(schema);
  }
}

/** A schema's object shape, as far as the mutation engine needs it: no recursion. */
interface ObjectShape {
  readonly properties: Readonly<Record<string, TSchema>>;
  readonly required: readonly string[];
}

/**
 * Reads the top-level object shape a fixture's mutations are built from.
 *
 * A plain object schema is used directly. A union (the two result schemas in
 * this catalog with no top-level `properties`) is resolved to whichever
 * branch the seed actually satisfies, so a mutation targets the branch the
 * seed came from rather than an arbitrary one. `null` when neither applies —
 * the seed fixture still gets emitted, just with no property-level mutations.
 */
export function objectShapeOf(schema: TSchema, seed: unknown): ObjectShape | null {
  const asRecord = schema as unknown as Record<string, unknown>;
  if (asRecord.type === 'object' && asRecord.properties) {
    return {
      properties: asRecord.properties as Record<string, TSchema>,
      required: (asRecord.required as readonly string[] | undefined) ?? [],
    };
  }
  const branches = asRecord.anyOf as TSchema[] | undefined;
  if (!branches) return null;
  const branch = branches.find((candidate) => Value.Check(candidate, seed));
  return branch ? objectShapeOf(branch, seed) : null;
}

/** A value of a different JSON type than `value`, for the "wrong type" mutation. */
function wrongTypeReplacement(value: unknown): unknown {
  if (typeof value === 'string') return 12_345;
  if (typeof value === 'number') return 'wrong-type';
  if (typeof value === 'boolean') return 'wrong-type';
  if (Array.isArray(value)) return 'wrong-type';
  if (value !== null && typeof value === 'object') return 'wrong-type';
  return 'wrong-type';
}

/** The declared numeric bounds of a property schema, or `null` when it has none. */
function numericBoundsOf(propertySchema: TSchema): { minimum?: number; maximum?: number } | null {
  const asRecord = propertySchema as unknown as Record<string, unknown>;
  const minimum = asRecord.minimum as number | undefined;
  const maximum = asRecord.maximum as number | undefined;
  if (minimum === undefined && maximum === undefined) return null;
  return { minimum, maximum };
}

/**
 * The set of literal values a property schema pins to a closed choice —
 * either a single `const` or a union whose every branch is a `const` — for
 * the "wrong const" mutation. `null` when the property does not close its
 * values this way.
 */
function constValuesOf(propertySchema: TSchema): readonly unknown[] | null {
  const asRecord = propertySchema as unknown as Record<string, unknown>;
  if ('const' in asRecord) return [asRecord.const];
  const branches = asRecord.anyOf as Record<string, unknown>[] | undefined;
  if (branches?.every((branch) => 'const' in branch)) {
    return branches.map((branch) => branch.const);
  }
  return null;
}

/** A value not in `values`, of a shape that still fits alongside them on the wire. */
function outsideConstValues(values: readonly unknown[]): unknown {
  if (values.every((value) => typeof value === 'string')) {
    let candidate = '__wrong_const__';
    while (values.includes(candidate)) candidate += '_';
    return candidate;
  }
  if (values.every((value) => typeof value === 'number')) {
    return Math.max(...(values as number[])) + 1000;
  }
  return '__wrong_const__';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Runs `Value.Check` and reports the verdict the way the corpus records it. */
function verdictOf(schema: TSchema, value: unknown): 'valid' | 'invalid' {
  return Value.Check(schema, value) ? 'valid' : 'invalid';
}

/**
 * Builds every fixture for one subject: the seed, plus one mutation per
 * required key (dropped), one per present property (wrong type, and where
 * applicable out-of-range or wrong-const), and one extra-property fixture.
 *
 * Each fixture's `expect` is computed by re-running `Value.Check`, never
 * assumed — most shapes in this contract are open objects, so an extra
 * property is usually still valid, and that is exactly the kind of
 * disagreement this corpus exists to catch rather than paper over.
 */
export function buildFixturesForSubject(subject: CorpusSubject, schema: TSchema): CorpusFixture[] {
  const key = subjectKey(subject);
  let seed: unknown;
  try {
    seed = createSeed(schema);
  } catch (cause) {
    throw new Error(
      `runtime-contract corpus: ${key} has no valid seed (${(cause as Error).message}). A ` +
        'subject with no valid seed would silently drop out of the conformance gate instead ' +
        'of failing here.'
    );
  }
  if (!Value.Check(schema, seed)) {
    throw new Error(
      `runtime-contract corpus: the seed for ${key} does not satisfy its own schema.`
    );
  }

  const fixtures: CorpusFixture[] = [{ subject, mutation: 'seed', value: seed, expect: 'valid' }];

  const shape = objectShapeOf(schema, seed);
  if (!shape || !isRecord(seed)) return fixtures;

  for (const requiredKey of shape.required) {
    if (!(requiredKey in seed)) continue;
    const mutated = { ...seed };
    delete mutated[requiredKey];
    fixtures.push({
      subject,
      mutation: `drop:${requiredKey}`,
      value: mutated,
      expect: verdictOf(schema, mutated),
    });
  }

  for (const [propertyKey, propertySchema] of Object.entries(shape.properties)) {
    if (!(propertyKey in seed)) continue;
    const currentValue = seed[propertyKey];

    const wrongTyped = { ...seed, [propertyKey]: wrongTypeReplacement(currentValue) };
    fixtures.push({
      subject,
      mutation: `wrongType:${propertyKey}`,
      value: wrongTyped,
      expect: verdictOf(schema, wrongTyped),
    });

    const bounds = numericBoundsOf(propertySchema);
    if (bounds && typeof currentValue === 'number') {
      const outOfRange =
        bounds.minimum !== undefined ? bounds.minimum - 1 : (bounds.maximum ?? 0) + 1;
      const mutated = { ...seed, [propertyKey]: outOfRange };
      fixtures.push({
        subject,
        mutation: `outOfRange:${propertyKey}`,
        value: mutated,
        expect: verdictOf(schema, mutated),
      });
    }

    const constValues = constValuesOf(propertySchema);
    if (constValues) {
      const mutated = { ...seed, [propertyKey]: outsideConstValues(constValues) };
      fixtures.push({
        subject,
        mutation: `wrongConst:${propertyKey}`,
        value: mutated,
        expect: verdictOf(schema, mutated),
      });
    }
  }

  const withExtra = { ...seed, __unexpected_extra_field__: 'unexpected-value' };
  fixtures.push({
    subject,
    mutation: 'extraProperty',
    value: withExtra,
    expect: verdictOf(schema, withExtra),
  });

  return fixtures;
}

/** Every fixture the current contract produces, method params/result then topic payloads. */
export function buildCorpus(): CorpusFixture[] {
  const fixtures: CorpusFixture[] = [];
  for (const [name, definition] of Object.entries(RUNTIME_CONTRACT.definition.methods)) {
    fixtures.push(
      ...buildFixturesForSubject({ kind: 'method', name, side: 'params' }, definition.params)
    );
    fixtures.push(
      ...buildFixturesForSubject({ kind: 'method', name, side: 'result' }, definition.result)
    );
  }
  for (const [topic, definition] of Object.entries(RUNTIME_CONTRACT.definition.events ?? {})) {
    fixtures.push(...buildFixturesForSubject({ kind: 'topic', name: topic }, definition.payload));
  }
  return fixtures;
}

/** The committed corpus document: `bun run contracts:emit`'s seventh artifact. */
export function corpusDocument(): Record<string, unknown> {
  return {
    $comment: `Generated from apps/shared/src/runtime-contract. Regenerate with "bun run contracts:emit".`,
    description:
      'Behavioural conformance corpus: one TypeBox-verified verdict per fixture, checked ' +
      'against every method params/result and topic payload schema in catalog.json. A ' +
      'non-TypeScript validator is conformant when it reproduces every "expect" here.',
    fixtures: buildCorpus(),
  };
}
