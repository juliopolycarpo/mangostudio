import { describe, expect, it } from 'bun:test';
import { ExternalAgentEventSchema } from '@mangostudio/shared/external-agents';
import { RuntimeTerminalOutputEventSchema } from '@mangostudio/shared/runtime-contract';
import { Type } from 'typebox';
import {
  checkContractCompatible,
  schemaByDiscriminant,
} from '../../../../src/services/runtime-client/contract-compat';

describe('checkContractCompatible', () => {
  it('accepts a value that matches the schema exactly', () => {
    const schema = Type.Object({ ok: Type.Boolean() });
    expect(checkContractCompatible(schema, { ok: true })).toEqual({ ok: true });
  });

  it('tolerates a top-level additive field', () => {
    const schema = Type.Object({ ok: Type.Boolean() });
    const result = checkContractCompatible(schema, {
      ok: true,
      futureField: 'from a newer runtime',
    });
    expect(result.ok).toBe(true);
  });

  it('tolerates an additive field nested inside a union branch', () => {
    // `runtime.health` and `probing.agent-clis` both nest a union many levels
    // deep; a naive "strip additionalProperties at the top only" fix would
    // miss exactly this shape.
    const schema = Type.Object({
      status: Type.Union([
        Type.Object({ ok: Type.Literal(true), value: Type.String() }),
        Type.Object({ ok: Type.Literal(false), reason: Type.String() }),
      ]),
    });
    const result = checkContractCompatible(schema, {
      status: { ok: true, value: 'x', futureField: 'from a newer runtime' },
    });
    expect(result.ok).toBe(true);
  });

  it('still rejects a wrong type under additive tolerance', () => {
    const schema = Type.Object({ ok: Type.Boolean() });
    const result = checkContractCompatible(schema, { ok: 'not-a-boolean', extra: 1 });
    expect(result.ok).toBe(false);
  });

  it('still rejects a missing required field under additive tolerance', () => {
    const schema = Type.Object({ ok: Type.Boolean(), value: Type.String() });
    const result = checkContractCompatible(schema, { ok: true, extra: 1 });
    expect(result.ok).toBe(false);
  });

  it('does not let one union branch’s unrelated errors reject a value the other branch accepts leniently', () => {
    // The bug a whole-union `Value.Errors` filter would produce: branch A
    // matches (after tolerance), but branch B's `const` mismatch on the same
    // discriminant is a structural-looking error that must not veto branch A.
    const schema = Type.Union([
      Type.Object({ ok: Type.Literal(true), value: Type.String() }),
      Type.Object({ ok: Type.Literal(false), reason: Type.String() }),
    ]);
    const result = checkContractCompatible(schema, { ok: true, value: 'x', futureField: 'extra' });
    expect(result.ok).toBe(true);
  });
});

describe('schemaByDiscriminant', () => {
  it('captures every branch of a real contract union', () => {
    const byType = schemaByDiscriminant(ExternalAgentEventSchema, 'type');
    // Every branch is a plain object with an inline `type` literal today; a
    // branch this cannot read from would silently shrink the map instead of
    // failing loudly, so this is the guard that catches it.
    expect(byType.size).toBe(ExternalAgentEventSchema.anyOf.length);
    expect(byType.has('completed')).toBe(true);
    expect(byType.has('error')).toBe(true);
  });

  it('captures every branch of terminal.output’s kind union', () => {
    // Guards `hub-session.ts`'s unknown-`kind`-passes-through rule: a branch
    // this map silently dropped would make a real `kind: 'exit'` frame look
    // unrecognized and pass through unvalidated instead of being checked.
    const byKind = schemaByDiscriminant(RuntimeTerminalOutputEventSchema, 'kind');
    expect(byKind.size).toBe(RuntimeTerminalOutputEventSchema.anyOf.length);
    expect(byKind.has('data')).toBe(true);
    expect(byKind.has('exit')).toBe(true);
  });

  it('looks up one branch by its discriminant value', () => {
    const byType = schemaByDiscriminant(ExternalAgentEventSchema, 'type');
    const errorBranch = byType.get('error');
    if (!errorBranch) throw new Error('expected an "error" branch in ExternalAgentEventSchema');
    expect(
      checkContractCompatible(errorBranch, { type: 'error', error: { code: 'x', message: 'y' } })
    ).toEqual({ ok: true });
  });

  it('returns an empty map for a schema with no discriminated union', () => {
    const schema = Type.Object({ ok: Type.Boolean() });
    expect(schemaByDiscriminant(schema, 'type').size).toBe(0);
  });
});
