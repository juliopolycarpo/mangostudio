import Type, { type Static } from 'typebox';

/** Header external callers present a key on. */
export const API_KEY_HEADER = 'x-api-key';

/** Product limits shared by the API and its consumers. */
export const API_KEY_NAME_MAX_LENGTH = 64;
export const API_KEY_EXPIRY_MAX_DAYS = 365;
export const API_KEY_MAX_PER_USER = 20;

/** `read-only` allows GET/HEAD/OPTIONS only; `full` allows every method. */
export const ApiKeyScopeSchema = Type.Union([Type.Literal('read-only'), Type.Literal('full')]);
export type ApiKeyScope = Static<typeof ApiKeyScopeSchema>;

/**
 * Selectable scopes in schema order. Derived from `ApiKeyScopeSchema` so a new
 * literal reaches every consumer (pickers, docs, tests) without a second list
 * to keep in sync.
 */
export const API_KEY_SCOPES: readonly ApiKeyScope[] = ApiKeyScopeSchema.anyOf.map(
  (literal) => literal.const
);

const ISO_DATE_TIME_PATTERN = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$';
const DateTimeSchema = Type.String({ pattern: ISO_DATE_TIME_PATTERN });
const NullableDateTimeSchema = Type.Union([DateTimeSchema, Type.Null()]);

/**
 * Public, non-secret API key metadata. `name` remains nullable for keys created
 * before names became mandatory, and `start` is Better Auth's stored key hint.
 */
export const ApiKeySummarySchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    name: Type.Union([
      Type.String({ minLength: 1, maxLength: API_KEY_NAME_MAX_LENGTH }),
      Type.Null(),
    ]),
    scope: ApiKeyScopeSchema,
    start: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    createdAt: DateTimeSchema,
    expiresAt: NullableDateTimeSchema,
    lastUsedAt: NullableDateTimeSchema,
  },
  { additionalProperties: false }
);
export type ApiKeySummary = Static<typeof ApiKeySummarySchema>;

export const CreateApiKeyBodySchema = Type.Object(
  {
    name: Type.String({
      minLength: 1,
      maxLength: API_KEY_NAME_MAX_LENGTH,
      pattern: '\\S',
    }),
    scope: ApiKeyScopeSchema,
    expiresInDays: Type.Optional(Type.Integer({ minimum: 1, maximum: API_KEY_EXPIRY_MAX_DAYS })),
  },
  { additionalProperties: false }
);
export type CreateApiKeyBody = Static<typeof CreateApiKeyBodySchema>;

export const CreateApiKeyResponseSchema = Type.Object(
  {
    key: Type.String({ minLength: 1 }),
    summary: ApiKeySummarySchema,
  },
  { additionalProperties: false }
);
export type CreateApiKeyResponse = Static<typeof CreateApiKeyResponseSchema>;

export const ListApiKeysResponseSchema = Type.Object(
  {
    keys: Type.Array(ApiKeySummarySchema),
  },
  { additionalProperties: false }
);
export type ListApiKeysResponse = Static<typeof ListApiKeysResponseSchema>;
