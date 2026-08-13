/**
 * The TypeBox operators and emitted JSON Schema keywords this repository
 * depends on for behavior, not just for typing.
 *
 * Most schema usage here is declarative and a compile error would catch a
 * regression. These cases are the ones where it would not: production code
 * reads `anyOf` back at module load to build runtime constant arrays, wraps an
 * array in `Type.Unsafe` to keep a readonly type, and relies on `Type.Never`,
 * `Type.Exclude`, `Type.Omit`, and anchored patterns to *reject* values. A
 * schema library that keeps compiling while emitting a different keyword turns
 * each of those into a silent behavior change.
 */

import { describe, expect, it } from 'bun:test';
import Type, { type Static } from 'typebox';
import Value from 'typebox/value';

import { API_KEY_SCOPES, ApiKeyScopeSchema } from '../../src/api-keys';
import { EnvironmentIdSchema, NodeVersionSpecSchema } from '../../src/environments';
import {
  EXTERNAL_AGENT_TARGET_IDS,
  ExternalAgentDiscoverParamsSchema,
  ExternalAgentRuntimeDescriptorSchema,
  ExternalAgentTargetIdSchema,
} from '../../src/external-agents';
import { GIT_SCOPES, RealtimeInvalidateMessageSchema, SETTINGS_SCOPES } from '../../src/realtime';
import { RUNTIME_SLOTS, RuntimeSlotSchema } from '../../src/runtime-home';
import { ReadonlyArraySchema } from '../../src/schema-helpers';
import { TOOL_EXECUTION_STATUSES, ToolExecutionStatusSchema } from '../../src/tool-executions';

/** Read a stable JSON Schema keyword without asserting TypeBox's own annotations. */
function keyword<T>(schema: unknown, name: string): T {
  return (schema as Record<string, T>)[name] as T;
}

describe('unions emit anyOf with const members', () => {
  // Every constant below is derived at module load with
  // `Schema.anyOf.map((member) => member.const)`. A union that emits `enum`,
  // `oneOf`, or members without `const` leaves these arrays full of
  // `undefined` — and every `includes()` guard built on them starts refusing
  // valid input, at import time, with no type error anywhere.
  const derived: { name: string; schema: unknown; constants: readonly string[] }[] = [
    { name: 'API_KEY_SCOPES', schema: ApiKeyScopeSchema, constants: API_KEY_SCOPES },
    { name: 'RUNTIME_SLOTS', schema: RuntimeSlotSchema, constants: RUNTIME_SLOTS },
    {
      name: 'EXTERNAL_AGENT_TARGET_IDS',
      schema: ExternalAgentTargetIdSchema,
      constants: EXTERNAL_AGENT_TARGET_IDS,
    },
  ];

  it.each(derived)('$name is a fully populated list of literal values', ({ schema, constants }) => {
    const members = keyword<{ const?: string }[]>(schema, 'anyOf');

    expect(Array.isArray(members)).toBe(true);
    expect(members.length).toBeGreaterThan(0);
    expect(constants.length).toBe(members.length);
    expect(constants.every((value) => typeof value === 'string' && value.length > 0)).toBe(true);
    expect([...constants]).toEqual(members.map((member) => member.const as string));
  });

  it('keeps the realtime scope lists non-empty and validating', () => {
    expect(SETTINGS_SCOPES.length).toBeGreaterThan(0);
    expect(GIT_SCOPES.length).toBeGreaterThan(0);
    for (const scope of SETTINGS_SCOPES) expect(typeof scope).toBe('string');
    for (const scope of GIT_SCOPES) expect(typeof scope).toBe('string');
  });

  it('sizes a bounded array from the union member count', () => {
    // `maxItems: ExternalAgentTargetIdSchema.anyOf.length` — an undefined
    // length would drop the bound rather than fail loudly.
    const maxItems = keyword<number>(
      keyword<object>(ExternalAgentDiscoverParamsSchema, 'properties'),
      'targetIds'
    );

    expect(keyword<number>(maxItems, 'maxItems')).toBe(EXTERNAL_AGENT_TARGET_IDS.length);
  });
});

describe('dynamically built literal unions', () => {
  // Built as `Type.Union(VALUES.map((v) => Type.Literal(v)))` rather than
  // written out, so the schema and the exported tuple cannot drift.
  it('accepts every declared status and rejects an undeclared one', () => {
    for (const status of TOOL_EXECUTION_STATUSES) {
      expect(Value.Check(ToolExecutionStatusSchema, status)).toBe(true);
    }
    expect(Value.Check(ToolExecutionStatusSchema, 'not-a-status')).toBe(false);
    expect(keyword<unknown[]>(ToolExecutionStatusSchema, 'anyOf')).toHaveLength(
      TOOL_EXECUTION_STATUSES.length
    );
  });
});

describe('Type.Never as an optional field', () => {
  // The environments and external-agents invalidate messages carry
  // `scopes: Type.Optional(Type.Never())` so the union stays ergonomic while
  // still refusing a scoped payload on a topic that has no scopes. If
  // `Type.Never` starts accepting values, those two arms silently widen and a
  // scoped environments invalidation would validate.
  it('accepts the field absent and rejects it present with any value', () => {
    const base = { type: 'invalidate', topic: 'environments' } as const;

    expect(Value.Check(RealtimeInvalidateMessageSchema, base)).toBe(true);
    expect(Value.Check(RealtimeInvalidateMessageSchema, { ...base, scopes: [] })).toBe(false);
    expect(Value.Check(RealtimeInvalidateMessageSchema, { ...base, scopes: ['state'] })).toBe(
      false
    );
    expect(Value.Check(RealtimeInvalidateMessageSchema, { ...base, scopes: undefined })).toBe(true);
  });

  it('still accepts scopes on the arms that declare them', () => {
    expect(
      Value.Check(RealtimeInvalidateMessageSchema, {
        type: 'invalidate',
        topic: 'settings',
        scopes: ['app'],
      })
    ).toBe(true);
  });
});

describe('Type.Exclude over a literal union', () => {
  it('narrows the union and rejects the removed member', () => {
    const Status = Type.Union([
      Type.Literal('running'),
      Type.Literal('succeeded'),
      Type.Literal('failed'),
    ]);
    const Terminal = Type.Exclude(Status, Type.Literal('running'));

    expect(Value.Check(Terminal, 'succeeded')).toBe(true);
    expect(Value.Check(Terminal, 'failed')).toBe(true);
    expect(Value.Check(Terminal, 'running')).toBe(false);
  });

  it('collapses to a bare const when one member remains', () => {
    // `InstallRunTerminalStatusSchema` excludes exactly one member from a
    // seven-member union, so it stays an `anyOf`. This narrower case pins the
    // shape a consumer sees when the exclusion leaves a single literal, which
    // is what an `anyOf`-reading consumer would trip over.
    const Single = Type.Exclude(
      Type.Union([Type.Literal('a'), Type.Literal('b')]),
      Type.Literal('a')
    );

    expect(keyword<unknown>(Single, 'anyOf')).toBeUndefined();
    expect(keyword<unknown>(Single, 'const')).toBe('b');
    expect(Value.Check(Single, 'b')).toBe(true);
    expect(Value.Check(Single, 'a')).toBe(false);
  });
});

describe('Type.Omit on a composed shape', () => {
  it('drops only the named key and keeps the rest required', () => {
    const source = keyword<string[]>(ExternalAgentRuntimeDescriptorSchema, 'required');
    const properties = Object.keys(
      keyword<object>(ExternalAgentRuntimeDescriptorSchema, 'properties')
    );

    expect(properties).not.toContain('environmentId');
    expect(source).not.toContain('environmentId');
    expect(source).toContain('targetId');
    expect(properties).toContain('capabilities');
  });

  it('rejects the omitted key when the source object is strict', () => {
    // The source declares `additionalProperties: false`; the omit must carry
    // that through, or a runtime could keep sending the hub-owned id it is not
    // allowed to author.
    const descriptor = {
      targetId: EXTERNAL_AGENT_TARGET_IDS[0],
      installed: false,
      authState: 'unknown',
      capabilities: {},
      supportedConfigurations: [],
    };

    expect(
      Value.Check(ExternalAgentRuntimeDescriptorSchema, { ...descriptor, environmentId: 'x' })
    ).toBe(false);
  });
});

describe('Type.Record emitted as patternProperties', () => {
  it('validates values and rejects a wrong-typed entry', () => {
    const Details = Type.Record(Type.String(), Type.String());

    expect(keyword<object>(Details, 'patternProperties')).toBeDefined();
    expect(Value.Check(Details, { reason: 'expired' })).toBe(true);
    expect(Value.Check(Details, { reason: 1 })).toBe(false);
    expect(Value.Check(Details, {})).toBe(true);
  });
});

describe('anchored string patterns', () => {
  // Both patterns are anchored at both ends. An unanchored rewrite would accept
  // a prefixed or suffixed value — and, for the version spec, is the shape that
  // makes a pattern backtrack.
  it('rejects values that merely contain a match', () => {
    expect(Value.Check(EnvironmentIdSchema, 'workshop')).toBe(true);
    expect(Value.Check(EnvironmentIdSchema, 'Workshop')).toBe(false);
    expect(Value.Check(EnvironmentIdSchema, 'work shop')).toBe(false);
    expect(Value.Check(EnvironmentIdSchema, '-workshop')).toBe(false);
    expect(Value.Check(EnvironmentIdSchema, 'workshop-')).toBe(false);

    expect(Value.Check(NodeVersionSpecSchema, 'lts')).toBe(true);
    expect(Value.Check(NodeVersionSpecSchema, '22.1.0')).toBe(true);
    expect(Value.Check(NodeVersionSpecSchema, 'v22.1.0')).toBe(false);
    expect(Value.Check(NodeVersionSpecSchema, '22.1.0; rm -rf /')).toBe(false);
  });

  it('enforces the declared length bounds alongside the pattern', () => {
    expect(Value.Check(EnvironmentIdSchema, '')).toBe(false);
    expect(Value.Check(EnvironmentIdSchema, 'a'.repeat(64))).toBe(false);
    expect(Value.Check(EnvironmentIdSchema, 'a'.repeat(63))).toBe(true);
  });
});

describe('ReadonlyArraySchema across the Type.Unsafe boundary', () => {
  // `ReadonlyArraySchema` is `Type.Unsafe<ReadonlyArray<T>>(Type.Array(item))`:
  // the wrapper exists only to keep the derived type readonly, and must not
  // change what the schema emits or validates. `Type.Unsafe` is the one place
  // a static type is asserted rather than derived, so a change in how it
  // forwards its inner schema would be invisible to the compiler.
  const Names = ReadonlyArraySchema(Type.String({ minLength: 1 }), {
    minItems: 1,
    maxItems: 2,
    uniqueItems: true,
  });

  it('emits a plain array schema, not an opaque one', () => {
    expect(keyword<string>(Names, 'type')).toBe('array');
    expect(keyword<object>(Names, 'items')).toBeDefined();
    expect(keyword<number>(Names, 'minItems')).toBe(1);
    expect(keyword<number>(Names, 'maxItems')).toBe(2);
    expect(keyword<boolean>(Names, 'uniqueItems')).toBe(true);
  });

  it('enforces every forwarded option at runtime', () => {
    expect(Value.Check(Names, ['a'])).toBe(true);
    expect(Value.Check(Names, [])).toBe(false);
    expect(Value.Check(Names, ['a', 'b', 'c'])).toBe(false);
    expect(Value.Check(Names, ['a', 'a'])).toBe(false);
    expect(Value.Check(Names, [''])).toBe(false);
    expect(Value.Check(Names, 'a')).toBe(false);
  });

  it('still validates when nested inside a strict object', () => {
    // The real nesting: `ExternalAgentDiscoverParamsSchema` puts one inside a
    // `{ additionalProperties: false }` object with its own bounds.
    const valid = {
      targetIds: [EXTERNAL_AGENT_TARGET_IDS[0]],
      timeoutMs: 30_000,
    };

    expect(Value.Check(ExternalAgentDiscoverParamsSchema, valid)).toBe(true);
    expect(Value.Check(ExternalAgentDiscoverParamsSchema, { ...valid, targetIds: [] })).toBe(false);
    expect(Value.Check(ExternalAgentDiscoverParamsSchema, { ...valid, targetIds: ['nope'] })).toBe(
      false
    );
    expect(Value.Check(ExternalAgentDiscoverParamsSchema, { ...valid, extra: 1 })).toBe(false);
  });
});

describe('Value.Equal', () => {
  // `runtime-connection-manager` diffs a capability manifest with `Value.Equal`
  // to decide whether a runtime's manifest changed. A looser comparison
  // republishes on every heartbeat; a stricter one stops reporting real drift.
  it('compares structurally and ignores key order', () => {
    expect(Value.Equal({ a: 1, b: [2, 3] }, { b: [2, 3], a: 1 })).toBe(true);
    expect(Value.Equal({ a: 1 }, { a: 2 })).toBe(false);
    expect(Value.Equal([1, 2], [2, 1])).toBe(false);
  });

  it('treats an explicit undefined as different from an absent key', () => {
    expect(Value.Equal({ a: undefined }, {})).toBe(false);
  });

  it('recurses into nested objects and arrays', () => {
    const manifest = { features: { git: true, tools: true }, shells: ['bash'] };

    expect(Value.Equal(manifest, structuredClone(manifest))).toBe(true);
    expect(Value.Equal(manifest, { ...manifest, shells: ['bash', 'zsh'] })).toBe(false);
    expect(Value.Equal(manifest, { ...manifest, features: { git: true, tools: false } })).toBe(
      false
    );
  });
});

describe('Static<> derivation over the helpers', () => {
  it('keeps derived values assignable at compile time', () => {
    // Annotated rather than inferred, so a helper that stops producing the
    // documented type fails `bun run check` instead of this assertion.
    const scopes: readonly Static<typeof ApiKeyScopeSchema>[] = API_KEY_SCOPES;
    const names: ReadonlyArray<string> = ['a'] satisfies Static<
      ReturnType<typeof ReadonlyArraySchema<ReturnType<typeof Type.String>>>
    >;

    expect(scopes.length).toBeGreaterThan(0);
    expect(names).toHaveLength(1);
  });
});
