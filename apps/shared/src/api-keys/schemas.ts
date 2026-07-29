import { type Static, Type } from '@sinclair/typebox';

/** Header external callers present a key on. */
export const API_KEY_HEADER = 'x-api-key';

/** `read-only` allows GET/HEAD/OPTIONS only; `full` allows every method. */
export const ApiKeyScopeSchema = Type.Union([Type.Literal('read-only'), Type.Literal('full')]);
export type ApiKeyScope = Static<typeof ApiKeyScopeSchema>;
