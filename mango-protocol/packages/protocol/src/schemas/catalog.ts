/**
 * The catalog document of spec/schema/1/catalog.json: how an application
 * describes its methods, events and capabilities.
 *
 * A catalog is a description, not a wire message. SDKs use it to type clients
 * and validate handlers.
 */

import Type, { type Static } from 'typebox';
import Value from 'typebox/value';
import { CodecError } from '../errors';
import { describeSchemaFailure, MethodSchema, PEER_FIELD_MAX_LENGTH, TopicSchema } from './common';
import { ProtocolVersionSchema } from './frames';

/**
 * A JSON Schema 2020-12 document carried inside a catalog: `params`, `result`,
 * `payload` and `capabilities`. Open, like every object on this wire.
 */
const JsonSchemaDocumentSchema = Type.Unsafe<Record<string, unknown>>({
  type: 'object',
  description: 'A JSON Schema 2020-12 document.',
});

/** One method the contract serves. */
export const CatalogMethodSchema = Type.Object({
  name: MethodSchema,
  description: Type.Optional(Type.String()),
  params: JsonSchemaDocumentSchema,
  result: JsonSchemaDocumentSchema,
  capabilities: Type.Optional(
    Type.Array(Type.String({ minLength: 1 }), {
      uniqueItems: true,
      description:
        'Members of hello.capabilities the responder requires before serving this method.',
    })
  ),
  deprecated: Type.Optional(Type.Boolean()),
});
export type CatalogMethod = Static<typeof CatalogMethodSchema>;

/** One event topic the contract emits. */
export const CatalogEventSchema = Type.Object({
  topic: TopicSchema,
  description: Type.Optional(Type.String()),
  payload: JsonSchemaDocumentSchema,
  stream: Type.Optional(
    Type.Boolean({
      description: 'True when events on this topic carry a streamId and an end marker.',
    })
  ),
});
export type CatalogEvent = Static<typeof CatalogEventSchema>;

/** An application contract: its methods, events and capabilities. */
export const CatalogSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: PEER_FIELD_MAX_LENGTH }),
    version: Type.String({ minLength: 1, maxLength: PEER_FIELD_MAX_LENGTH }),
    description: Type.Optional(Type.String()),
    protocol: Type.Optional(
      Type.Unsafe<Static<typeof ProtocolVersionSchema>>({
        ...ProtocolVersionSchema,
        description: 'Lowest wire version the contract needs.',
      })
    ),
    methods: Type.Array(CatalogMethodSchema),
    events: Type.Optional(Type.Array(CatalogEventSchema)),
    capabilities: Type.Optional(
      Type.Unsafe<Record<string, unknown>>({
        type: 'object',
        description: 'JSON Schema of the hello.capabilities object this contract expects.',
      })
    ),
  },
  {
    description:
      'Describes an application contract: its methods, events and capabilities. A description, not a wire message.',
  }
);
export type Catalog = Static<typeof CatalogSchema>;

/**
 * True when `value` is a catalog document this SDK understands. Unknown members
 * are ignored, as they are on the wire.
 *
 * @example
 * isCatalog({ name: 'runtime', version: '2.0.0', methods: [] }); // true
 */
export function isCatalog(value: unknown): value is Catalog {
  return Value.Check(CatalogSchema, value);
}

/**
 * Narrows `value` to a `Catalog` or throws a `CodecError` of kind `schema`
 * naming the member that failed and the value received.
 *
 * @example
 * assertCatalog(JSON.parse(await file.text()));
 */
export function assertCatalog(value: unknown): asserts value is Catalog {
  if (isCatalog(value)) return;
  throw new CodecError(
    'schema',
    describeSchemaFailure('catalog does not match catalog.json', CatalogSchema, value)
  );
}
