import { describe, expect, it } from 'bun:test';
import { ExternalAgentEventSchema } from '@mangostudio/shared/external-agents';
import { RuntimeTerminalOutputEventSchema } from '@mangostudio/shared/runtime-contract';
import { Type } from 'typebox';
import {
  checkAgainstContract,
  schemaByDiscriminant,
} from '../../../../src/services/runtime-client/contract-schema';

describe('checkAgainstContract', () => {
  it('accepts a value that matches the schema exactly', () => {
    const schema = Type.Object({ ok: Type.Boolean() });
    expect(checkAgainstContract(schema, { ok: true })).toEqual({ ok: true });
  });

  it('accepts an additive field on an open schema, exactly as plain Value.Check would', () => {
    // `RUNTIME_CONTRACT`'s schemas are written open by default (see
    // `contract.ts`'s own docblock) precisely so this needs no help from this
    // module: `additionalProperties` is simply absent.
    const schema = Type.Object({ ok: Type.Boolean() });
    const result = checkAgainstContract(schema, { ok: true, futureField: 'from a newer runtime' });
    expect(result.ok).toBe(true);
  });

  it('rejects an additive field on a schema closed on purpose', () => {
    // The `external-agent.*` family, `ToolchainSelection`, and a few others
    // close deliberately as a review boundary — an unreviewed member must
    // still be rejected, not tolerated.
    const schema = Type.Object({ ok: Type.Boolean() }, { additionalProperties: false });
    const result = checkAgainstContract(schema, { ok: true, injectedMember: 'unreviewed' });
    expect(result.ok).toBe(false);
  });

  it('rejects a wrong type', () => {
    const schema = Type.Object({ ok: Type.Boolean() });
    const result = checkAgainstContract(schema, { ok: 'not-a-boolean' });
    expect(result.ok).toBe(false);
  });

  it('rejects a missing required field', () => {
    const schema = Type.Object({ ok: Type.Boolean(), value: Type.String() });
    const result = checkAgainstContract(schema, { ok: true });
    expect(result.ok).toBe(false);
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
      checkAgainstContract(errorBranch, { type: 'error', error: { code: 'x', message: 'y' } })
    ).toEqual({ ok: true });
  });

  it('returns an empty map for a schema with no discriminated union', () => {
    const schema = Type.Object({ ok: Type.Boolean() });
    expect(schemaByDiscriminant(schema, 'type').size).toBe(0);
  });
});
