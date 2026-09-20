import { describe, expect, it } from 'bun:test';
import { Type } from 'typebox';
import {
  describeContractViolation,
  RuntimeContractViolationError,
} from '../../../../src/services/runtime-client/contract-violation';

describe('describeContractViolation', () => {
  it('points at the offending member with TypeBox’s own description', () => {
    const schema = Type.Object({ content: Type.String() });
    expect(describeContractViolation(schema, { content: 12345 })).toEqual({
      path: '#/properties/content',
      message: 'must be string',
    });
  });

  it('roots the pointer at the schema itself when the value is the wrong shape entirely', () => {
    const schema = Type.Object({ content: Type.String() });
    expect(describeContractViolation(schema, 'not an object').path).toBe('#');
  });

  it('never echoes a peer-chosen record key into the path, only the schema location', () => {
    // `probing.*` results carry a `Type.Record(Type.String(), Type.String())`
    // (`findings[].params`); a value-derived `instancePath` would walk into it
    // by the peer's own key, which is exactly what this diagnostic must not
    // repeat. `schemaPath` is derived from the schema alone.
    const schema = Type.Object({ env: Type.Record(Type.String(), Type.String()) });
    const violation = describeContractViolation(schema, { env: { 'sk-live-SECRET': 42 } });
    expect(violation.path).not.toContain('sk-live-SECRET');
    expect(violation.message).not.toContain('sk-live-SECRET');
  });

  it('never echoes the rejected value into the description', () => {
    const schema = Type.Object({ token: Type.String() });
    // A value that actually violates the schema — a value that already
    // satisfies it produces no error, so asserting against one proves nothing.
    const violation = describeContractViolation(schema, { token: 12345, extra: 'SECRET-42' });
    expect(violation.message).not.toContain('SECRET-42');
    expect(violation.path).not.toContain('SECRET-42');
  });
});

describe('RuntimeContractViolationError', () => {
  it('names the subject and the violation path in its message', () => {
    const error = new RuntimeContractViolationError('result', 'fs.read-file', {
      path: '/content',
      message: 'must be string',
    });
    expect(error.name).toBe('RuntimeContractViolationError');
    expect(error.kind).toBe('result');
    expect(error.subject).toBe('fs.read-file');
    expect(error.path).toBe('/content');
    expect(error.message).toBe(
      'Runtime result for "fs.read-file" does not match the contract at /content: must be string.'
    );
  });

  it('never carries the rejected payload, only the path and TypeBox’s message', () => {
    const error = new RuntimeContractViolationError('event', 'terminal.output', {
      path: '/data',
      message: 'must be string',
    });
    expect(error.message).not.toContain('SECRET');
    expect(Object.keys(error)).toEqual(expect.arrayContaining(['kind', 'subject', 'path']));
    expect((error as unknown as { payload?: unknown }).payload).toBeUndefined();
  });
});
