import { describe, expect, it } from 'bun:test';
import Value from 'typebox/value';
import {
  API_KEY_EXPIRY_MAX_DAYS,
  API_KEY_NAME_MAX_LENGTH,
  ApiKeySummarySchema,
  CreateApiKeyBodySchema,
  CreateApiKeyResponseSchema,
  ListApiKeysResponseSchema,
} from '../../src/api-keys';

const summary = {
  id: 'key-1',
  name: 'Automation',
  scope: 'full',
  start: 'mango_',
  createdAt: '2026-07-29T12:00:00.000Z',
  expiresAt: null,
  lastUsedAt: null,
} as const;

describe('API key contracts', () => {
  it('accepts public summaries and nullable legacy fields', () => {
    expect(Value.Check(ApiKeySummarySchema, summary)).toBe(true);
    expect(
      Value.Check(ApiKeySummarySchema, {
        ...summary,
        name: null,
        start: null,
        expiresAt: '2026-08-29T12:00:00.000Z',
        lastUsedAt: '2026-07-29T12:30:00.000Z',
      })
    ).toBe(true);
  });

  it('rejects secret or plugin-internal fields on public responses', () => {
    expect(Value.Check(ApiKeySummarySchema, { ...summary, key: 'mango_secret' })).toBe(false);
    expect(
      Value.Check(ListApiKeysResponseSchema, {
        keys: [{ ...summary, metadata: { scope: 'full' } }],
      })
    ).toBe(false);
  });

  it('validates create request bounds', () => {
    expect(
      Value.Check(CreateApiKeyBodySchema, {
        name: 'a'.repeat(API_KEY_NAME_MAX_LENGTH),
        scope: 'read-only',
        expiresInDays: API_KEY_EXPIRY_MAX_DAYS,
      })
    ).toBe(true);
    expect(
      Value.Check(CreateApiKeyBodySchema, {
        name: '',
        scope: 'read-only',
      })
    ).toBe(false);
    expect(
      Value.Check(CreateApiKeyBodySchema, {
        name: '   ',
        scope: 'read-only',
      })
    ).toBe(false);
    expect(
      Value.Check(CreateApiKeyBodySchema, {
        name: 'Automation',
        scope: 'full',
        expiresInDays: API_KEY_EXPIRY_MAX_DAYS + 1,
      })
    ).toBe(false);
  });

  it('validates create and list response envelopes', () => {
    expect(Value.Check(CreateApiKeyResponseSchema, { key: 'mango_secret', summary })).toBe(true);
    expect(Value.Check(ListApiKeysResponseSchema, { keys: [summary] })).toBe(true);
  });
});
