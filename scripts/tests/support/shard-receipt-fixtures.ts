/** Named producer receipts spanning the current format and supported legacy artifacts. */
export const shardReceipts = {
  currentPass: {
    schemaVersion: 1,
    shard: 1,
    exitCode: 0,
    durationSeconds: 40,
    attempts: 1,
    failuresSeen: false,
  },
  measuredZero: {
    schemaVersion: 1,
    shard: 1,
    exitCode: 0,
    durationSeconds: 0,
    attempts: 1,
    failuresSeen: false,
  },
  legacyNoAttempts: { shard: 1, exitCode: 0, durationSeconds: 40 },
  legacyNoDuration: { shard: 1, exitCode: 0 },
  recoveredHang: {
    schemaVersion: 1,
    shard: 1,
    exitCode: 0,
    durationSeconds: 42,
    attempts: 2,
    failuresSeen: false,
  },
  retainedFindings: {
    schemaVersion: 1,
    shard: 1,
    exitCode: 0,
    durationSeconds: 42,
    attempts: 2,
    failuresSeen: true,
  },
  timeout: {
    schemaVersion: 1,
    shard: 1,
    exitCode: 124,
    durationSeconds: 42,
    attempts: 2,
    failuresSeen: false,
  },
} as const;

export const receiptText = (receipt: unknown): string => JSON.stringify(receipt);
