import { describe, expect, it } from 'bun:test';
import { ValidationError } from 'elysia';
import Type, { type TSchema } from 'typebox';
import { Validator as CompileValidator } from 'typebox/compile';
import { Validator as SchemaValidator } from 'typebox/schema';
import {
  type CompiledCheck,
  createJsonResponseEncoder,
  type JsonResponseCompilers,
  typeboxJsonResponseCompilers,
} from '../../../src/lib/compiled-json-response';

const ItemSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  runner: Type.Union([
    Type.Object({ kind: Type.Literal('a'), agentId: Type.String() }),
    Type.Object({ kind: Type.Literal('b'), targetId: Type.String() }),
  ]),
  note: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});
const ListSchema = Type.Array(ItemSchema);

/**
 * The real TypeBox compilers, counting how often each one is asked to build.
 * Compiling is the cost the encoder exists to pay once, so the count is the
 * behavior under test.
 */
class CountingCompilers implements JsonResponseCompilers {
  compiles = 0;
  mirrors = 0;

  compile(schema: TSchema): CompiledCheck {
    this.compiles++;
    return typeboxJsonResponseCompilers.compile(schema);
  }

  mirror(schema: TSchema): (value: unknown) => unknown {
    this.mirrors++;
    return typeboxJsonResponseCompilers.mirror(schema);
  }
}

describe('typeboxJsonResponseCompilers', () => {
  it('compiles with the typebox/schema compiler Elysia builds response validators with', () => {
    const check = typeboxJsonResponseCompilers.compile(ListSchema);

    const origin =
      check instanceof SchemaValidator
        ? 'typebox/schema'
        : check instanceof CompileValidator
          ? 'typebox/compile'
          : 'unknown';
    expect(origin).toBe('typebox/schema');
  });
});

describe('createJsonResponseEncoder', () => {
  it('serializes a valid value as a JSON response', async () => {
    const encode = createJsonResponseEncoder(ListSchema);
    const value = [
      { id: 'x', runner: { kind: 'a' as const, agentId: 'default' }, note: null },
      { id: 'y', runner: { kind: 'b' as const, targetId: 'codex' } },
    ];

    const response = encode(value);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json;charset=utf-8');
    expect(await response.text()).toBe(JSON.stringify(value));
  });

  it('compiles the check and the mirror once, on the first call only', () => {
    const compilers = new CountingCompilers();
    const encode = createJsonResponseEncoder(ListSchema, compilers);
    expect({ compiles: compilers.compiles, mirrors: compilers.mirrors }).toEqual({
      compiles: 0,
      mirrors: 0,
    });

    encode([]);
    encode([{ id: 'x', runner: { kind: 'a', agentId: 'default' } }]);
    encode([]);

    expect({ compiles: compilers.compiles, mirrors: compilers.mirrors }).toEqual({
      compiles: 1,
      mirrors: 1,
    });
  });

  it('drops keys the schema does not declare, at every depth', async () => {
    const encode = createJsonResponseEncoder(ListSchema);
    const leaky = [
      { id: 'x', secret: 's1', runner: { kind: 'a', agentId: 'default', token: 't1' } },
    ] as unknown as Parameters<typeof encode>[0];

    const body = await encode(leaky).text();

    expect(body).toBe(JSON.stringify([{ id: 'x', runner: { kind: 'a', agentId: 'default' } }]));
  });

  it('throws a response ValidationError naming the failing value when the value breaks the schema', () => {
    const encode = createJsonResponseEncoder(ListSchema);
    const invalid = [{ id: '', runner: { kind: 'a' as const, agentId: 'default' } }];

    let thrown: unknown;
    try {
      encode(invalid);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ValidationError);
    const error = thrown as ValidationError;
    expect({ type: error.type, value: error.value }).toEqual({ type: 'response', value: invalid });
    expect(error.errors.map((entry) => (entry as { instancePath?: string }).instancePath)).toEqual([
      '/0/id',
    ]);
  });
});
