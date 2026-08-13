/**
 * The JSON pointer a schema rejection reports.
 *
 * TypeBox reports Ajv-shaped errors, where `required` and `additionalProperties`
 * point at the enclosing object and name the offending keys in `params` instead.
 * Rendering `instancePath` straight through would collapse `/config/extra` to
 * `/` and drop the key name entirely — the diagnostic is the whole value of
 * these messages, so each container-level keyword is pinned by name here.
 */

import { describe, expect, it } from 'bun:test';
import Type, { type TSchema } from 'typebox';
import Value from 'typebox/value';

import { describeSchemaError, schemaErrorPointer } from '../../src/errors';

const Inner = Type.Object(
  { status: Type.String(), attempts: Type.Integer({ minimum: 1 }) },
  { additionalProperties: false }
);

const Outer = Type.Object(
  { jobs: Type.Array(Inner), label: Type.Optional(Type.String()) },
  { additionalProperties: false }
);

/** First violation for `value`, asserted to exist so the tests stay honest. */
const firstError = (schema: TSchema, value: unknown) => {
  const error = Value.Errors(schema, value).at(0);
  if (!error) throw new Error('expected the fixture to be rejected');
  return error;
};

describe('schemaErrorPointer', () => {
  it('points at the missing property, not the object that lacks it', () => {
    const pointer = schemaErrorPointer(firstError(Outer, { jobs: [{ attempts: 1 }] }));

    expect(pointer).toBe('/jobs/0/status');
  });

  it('points at the unexpected key, not the object that carries it', () => {
    const pointer = schemaErrorPointer(firstError(Outer, { jobs: [], surprise: 1 }));

    expect(pointer).toBe('/surprise');
  });

  it('keeps the natural location for a value-level violation', () => {
    const pointer = schemaErrorPointer(
      firstError(Outer, { jobs: [{ status: 'ok', attempts: 0 }] })
    );

    expect(pointer).toBe('/jobs/0/attempts');
  });

  it('renders a violation of the whole document as the root pointer', () => {
    expect(schemaErrorPointer(firstError(Outer, []))).toBe('/');
  });
});

describe('describeSchemaError', () => {
  it('renders the first violation as `<pointer>: <message>`', () => {
    const detail = describeSchemaError(Value.Errors(Outer, { jobs: [{}] }), 'unused fallback');

    expect(detail).toStartWith('/jobs/0/status: ');
    expect(detail.length).toBeGreaterThan('/jobs/0/status: '.length);
  });

  it('falls back when the value is valid and the error list is empty', () => {
    const detail = describeSchemaError(Value.Errors(Outer, { jobs: [] }), 'unknown violation');

    expect(detail).toBe('unknown violation');
  });

  it('never echoes the rejected value into the message', () => {
    const detail = describeSchemaError(
      Value.Errors(Outer, { jobs: [], token: 'super-secret-value' }),
      'unused fallback'
    );

    expect(detail).not.toContain('super-secret-value');
  });
});
