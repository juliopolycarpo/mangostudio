import { describe, expect, it } from 'bun:test';
import {
  DELEGATION_BACKOFF_BASE_MS,
  DELEGATION_BACKOFF_MAX_MS,
  DELEGATION_MAX_RETRIES,
} from '@mangostudio/shared/generation';
import {
  DELEGATION_BACKOFF_BASE_MS as originalBaseMs,
  DELEGATION_BACKOFF_MAX_MS as originalMaxMs,
  DELEGATION_MAX_RETRIES as originalMaxRetries,
} from '../../../src/agentic-limits';

describe('generation delegation limits', () => {
  it('re-exports the original base delay', () => {
    expect(DELEGATION_BACKOFF_BASE_MS).toBe(originalBaseMs);
    expect(DELEGATION_BACKOFF_BASE_MS).toBe(25);
  });

  it('re-exports the original delay cap', () => {
    expect(DELEGATION_BACKOFF_MAX_MS).toBe(originalMaxMs);
    expect(DELEGATION_BACKOFF_MAX_MS).toBe(400);
  });

  it('re-exports the original retry count', () => {
    expect(DELEGATION_MAX_RETRIES).toBe(originalMaxRetries);
    expect(DELEGATION_MAX_RETRIES).toBe(3);
  });
});
