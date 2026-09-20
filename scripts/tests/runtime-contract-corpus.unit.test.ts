import { describe, expect, test } from 'bun:test';
import { RUNTIME_CONTRACT } from '@mangostudio/shared/runtime-contract';
import Type from 'typebox';
import Value from 'typebox/value';
import {
  buildCorpus,
  buildFixturesForSubject,
  corpusDocument,
  objectShapeOf,
} from '../runtime-contract/corpus';

describe('runtime contract corpus', () => {
  describe('buildFixturesForSubject', () => {
    test('the seed fixture is valid against its own schema', () => {
      const schema = Type.Object({ text: Type.String() });
      const [seed] = buildFixturesForSubject({ kind: 'topic', name: 't.seed' }, schema);
      expect(seed.mutation).toBe('seed');
      expect(seed.expect).toBe('valid');
      expect(Value.Check(schema, seed.value)).toBe(true);
    });

    test('dropping a required key is invalid', () => {
      const schema = Type.Object({ a: Type.String(), b: Type.Optional(Type.String()) });
      const fixtures = buildFixturesForSubject({ kind: 'topic', name: 't.drop' }, schema);
      const dropped = fixtures.find((fixture) => fixture.mutation === 'drop:a');
      expect(dropped?.expect).toBe('invalid');
      expect(dropped?.value).toEqual({});
    });

    test('an optional key is never dropped — only required keys are mutated this way', () => {
      const schema = Type.Object({ a: Type.String(), b: Type.Optional(Type.String()) });
      const fixtures = buildFixturesForSubject({ kind: 'topic', name: 't.optional' }, schema);
      expect(fixtures.some((fixture) => fixture.mutation === 'drop:b')).toBe(false);
    });

    test('a wrong-typed property is checked, not assumed invalid', () => {
      // `a` accepts either a string or a number, so replacing the string seed
      // with a number is still valid — this is exactly the kind of case the
      // corpus exists to catch rather than assume.
      const schema = Type.Object({ a: Type.Union([Type.String(), Type.Number()]) });
      const fixtures = buildFixturesForSubject({ kind: 'topic', name: 't.wrongtype' }, schema);
      const wrongType = fixtures.find((fixture) => fixture.mutation === 'wrongType:a');
      expect(wrongType?.expect).toBe('valid');
    });

    test('a wrong-typed property against a closed type is invalid', () => {
      const schema = Type.Object({ a: Type.String() });
      const fixtures = buildFixturesForSubject({ kind: 'topic', name: 't.wrongtype2' }, schema);
      const wrongType = fixtures.find((fixture) => fixture.mutation === 'wrongType:a');
      expect(wrongType?.value).toEqual({ a: 12_345 });
      expect(wrongType?.expect).toBe('invalid');
    });

    test('an out-of-range number is mutated below its minimum', () => {
      const schema = Type.Object({ n: Type.Integer({ minimum: 1, maximum: 5 }) });
      const fixtures = buildFixturesForSubject({ kind: 'topic', name: 't.range' }, schema);
      const outOfRange = fixtures.find((fixture) => fixture.mutation === 'outOfRange:n');
      expect(outOfRange?.value).toEqual({ n: 0 });
      expect(outOfRange?.expect).toBe('invalid');
    });

    test('a property with no numeric bounds gets no out-of-range fixture', () => {
      const schema = Type.Object({ n: Type.Integer() });
      const fixtures = buildFixturesForSubject({ kind: 'topic', name: 't.norange' }, schema);
      expect(fixtures.some((fixture) => fixture.mutation.startsWith('outOfRange:'))).toBe(false);
    });

    test('a wrong-const value outside a literal union is invalid', () => {
      const schema = Type.Object({
        kind: Type.Union([Type.Literal('a'), Type.Literal('b')]),
      });
      const fixtures = buildFixturesForSubject({ kind: 'topic', name: 't.const' }, schema);
      const wrongConst = fixtures.find((fixture) => fixture.mutation === 'wrongConst:kind');
      expect(wrongConst?.expect).toBe('invalid');
    });

    test('an extra property is valid on an open object and invalid on a closed one', () => {
      const open = Type.Object({ a: Type.String() });
      const closed = Type.Object({ a: Type.String() }, { additionalProperties: false });

      const openExtra = buildFixturesForSubject({ kind: 'topic', name: 't.open' }, open).find(
        (fixture) => fixture.mutation === 'extraProperty'
      );
      const closedExtra = buildFixturesForSubject({ kind: 'topic', name: 't.closed' }, closed).find(
        (fixture) => fixture.mutation === 'extraProperty'
      );

      expect(openExtra?.expect).toBe('valid');
      expect(closedExtra?.expect).toBe('invalid');
    });

    test('a pattern-only string with no default is repaired rather than left to throw', () => {
      const schema = Type.Object({
        id: Type.String({ pattern: '^sha256:[a-f0-9]{64}$' }),
      });
      const [seed] = buildFixturesForSubject({ kind: 'topic', name: 't.pattern' }, schema);
      expect(seed.expect).toBe('valid');
      expect(Value.Check(schema, seed.value)).toBe(true);
    });

    test('a uniqueItems array with no default is repaired to an empty or single-item array', () => {
      const zeroMin = Type.Object({
        items: Type.Array(Type.String(), { uniqueItems: true }),
      });
      const oneMin = Type.Object({
        items: Type.Array(Type.String(), { uniqueItems: true, minItems: 1 }),
      });
      const zeroSeed = buildFixturesForSubject({ kind: 'topic', name: 't.unique0' }, zeroMin)[0];
      const oneSeed = buildFixturesForSubject({ kind: 'topic', name: 't.unique1' }, oneMin)[0];
      expect(zeroSeed.value).toEqual({ items: [] });
      expect((oneSeed.value as { items: unknown[] }).items).toHaveLength(1);
    });

    test('an unrecognised pattern fails loudly, naming the pattern, instead of dropping the subject', () => {
      const schema = Type.Object({ id: Type.String({ pattern: '^unknown-pattern$' }) });
      expect(() => buildFixturesForSubject({ kind: 'topic', name: 't.unknown' }, schema)).toThrow(
        /unknown-pattern/
      );
    });

    test('an unrecognised pattern inside a union branch still fails loudly, instead of silently seeding a later branch', () => {
      // Before the fix, the `anyOf` fallback in `manualCreate()` swallowed *any* throw from a
      // branch, including this one's unsatisfiable pattern, and fell through to `Type.Null()`
      // — a degenerate one-fixture seed of `null` that still passed
      // "every subject has at least one valid seed", just with zero mutations.
      const schema = Type.Union([
        Type.Object(
          { id: Type.String({ pattern: '^completely-unknown-pattern$' }) },
          { additionalProperties: false }
        ),
        Type.Null(),
      ]);
      expect(() =>
        buildFixturesForSubject({ kind: 'topic', name: 't.union-unknown' }, schema)
      ).toThrow(/completely-unknown-pattern/);
    });
  });

  describe('objectShapeOf', () => {
    test('resolves a union to the branch the seed actually satisfies', () => {
      const schema = Type.Union([
        Type.Object({ kind: Type.Literal('one'), n: Type.Number() }),
        Type.Object({ kind: Type.Literal('two'), s: Type.String() }),
      ]);
      const seed = { kind: 'two', s: 'x' };
      const shape = objectShapeOf(schema, seed);
      expect(shape && Object.keys(shape.properties).sort()).toEqual(['kind', 's']);
    });

    test('returns null for a schema with no object shape', () => {
      expect(objectShapeOf(Type.String(), 'x')).toBeNull();
    });
  });

  describe('buildCorpus', () => {
    test('covers every method side and every topic exactly once with a valid seed', () => {
      const fixtures = buildCorpus();
      const methodNames = Object.keys(RUNTIME_CONTRACT.definition.methods);
      const topicNames = Object.keys(RUNTIME_CONTRACT.definition.events ?? {});

      for (const name of methodNames) {
        for (const side of ['params', 'result'] as const) {
          const seeds = fixtures.filter(
            (fixture) =>
              fixture.mutation === 'seed' &&
              fixture.subject.kind === 'method' &&
              fixture.subject.name === name &&
              fixture.subject.side === side
          );
          expect(seeds).toHaveLength(1);
          expect(seeds[0]?.expect).toBe('valid');
        }
      }
      for (const topic of topicNames) {
        const seeds = fixtures.filter(
          (fixture) =>
            fixture.mutation === 'seed' &&
            fixture.subject.kind === 'topic' &&
            fixture.subject.name === topic
        );
        expect(seeds).toHaveLength(1);
        expect(seeds[0]?.expect).toBe('valid');
      }
    });
  });

  describe('corpusDocument', () => {
    test('renders byte-identically twice', () => {
      expect(JSON.stringify(corpusDocument())).toBe(JSON.stringify(corpusDocument()));
    });
  });
});
