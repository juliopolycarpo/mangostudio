import { describe, expect, it } from 'bun:test';

import {
  parseShardReceipt,
  serializeShardReceipt,
  validateShardReceipt,
} from '../lib/shard-receipt';
import { receiptText, shardReceipts } from './support/shard-receipt-fixtures';

describe('the shared shard receipt contract', () => {
  it('preserves measured zero and legacy unavailable fields separately', () => {
    expect(parseShardReceipt(receiptText(shardReceipts.measuredZero))).toMatchObject({
      kind: 'valid',
      receipt: { durationSeconds: 0, attempts: 1 },
    });
    expect(parseShardReceipt(receiptText(shardReceipts.legacyNoDuration))).toMatchObject({
      kind: 'valid',
      receipt: { durationSeconds: null, attempts: null, failuresSeen: null },
    });
    expect(parseShardReceipt(receiptText(shardReceipts.legacyNoAttempts))).toMatchObject({
      kind: 'valid',
      receipt: { durationSeconds: 40, attempts: null },
    });
  });

  it('lets consumers require fields unavailable in supported legacy artifacts', () => {
    expect(
      parseShardReceipt(receiptText(shardReceipts.legacyNoDuration), { requireDuration: true }).kind
    ).toBe('invalid');
    expect(
      parseShardReceipt(receiptText(shardReceipts.legacyNoAttempts), { requireAttempts: true }).kind
    ).toBe('invalid');
  });

  it.each([
    ['missing identity', { shard: undefined }],
    ['wrong identity', { shard: 2 }],
    ['ambiguous numeric string identity', { shard: '1' }],
    ['zero identity', { shard: 0 }],
    ['negative exit', { exitCode: -1 }],
    ['fractional exit', { exitCode: 0.5 }],
    ['nonfinite exit', { exitCode: Infinity }],
    ['out-of-range exit', { exitCode: 256 }],
    ['string duration', { durationSeconds: '0' }],
    ['negative duration', { durationSeconds: -1 }],
    ['nonfinite duration', { durationSeconds: NaN }],
    ['null duration', { durationSeconds: null }],
    ['missing current duration', { durationSeconds: undefined }],
    ['missing current attempts', { attempts: undefined }],
    ['zero attempts', { attempts: 0 }],
    ['more than the current two-attempt policy', { attempts: 3 }],
    ['fractional attempts', { attempts: 1.5 }],
    ['nonfinite attempts', { attempts: Infinity }],
    ['missing current findings', { failuresSeen: undefined }],
    ['malformed findings', { failuresSeen: 'false' }],
    ['unsupported version', { schemaVersion: 2 }],
  ])('rejects %s', (_name, change) => {
    expect(
      validateShardReceipt({ ...shardReceipts.currentPass, ...change }, { expectedShard: 1 }).kind
    ).toBe('invalid');
  });

  it.each([null, '', '{"shard":1', '[]', 'null'])(
    'fails closed for corrupt or absent JSON: %s',
    (text) => {
      expect(parseShardReceipt(text).kind).toBe('invalid');
    }
  );

  it('keeps retries that recovered a hang green and timeout124 failed', () => {
    expect(parseShardReceipt(receiptText(shardReceipts.recoveredHang))).toMatchObject({
      kind: 'valid',
      receipt: { exitCode: 0, attempts: 2 },
    });
    expect(parseShardReceipt(receiptText(shardReceipts.timeout))).toMatchObject({
      kind: 'valid',
      receipt: { exitCode: 124 },
    });
  });

  it('retains disallowed earlier findings even when the final attempt claims a pass', () => {
    expect(parseShardReceipt(receiptText(shardReceipts.retainedFindings))).toMatchObject({
      kind: 'valid',
      receipt: { exitCode: 1 },
    });
    expect(JSON.parse(serializeShardReceipt(shardReceipts.retainedFindings)).exitCode).toBe(1);
    expect(validateShardReceipt({ ...shardReceipts.retainedFindings, attempts: 1 })).toMatchObject({
      kind: 'valid',
      receipt: { exitCode: 1 },
    });
  });
});
