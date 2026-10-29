/** The source identity shared by a prepared frontend and its native hub builds. */
export interface FrontendBuildStamp {
  readonly gitSha: string;
  readonly gitDirty: boolean | 'unknown';
  readonly builtAt: string;
  readonly buildType: string;
}

/**
 * Reuse the prepared build time only when source, dirty state and mode match.
 * @example preparedFrontendBuildStamp(JSON.parse(text), currentBuildStamp)
 */
export function preparedFrontendBuildStamp(
  value: unknown,
  expected: FrontendBuildStamp
): FrontendBuildStamp {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`expected frontend build-info object | received: ${JSON.stringify(value)}`);
  }
  const record = value as Record<string, unknown>;
  if (expected.gitDirty !== false) {
    throw new Error(
      `expected prepared frontend source: clean | received gitDirty: ${String(expected.gitDirty)}`
    );
  }
  for (const field of ['gitSha', 'gitDirty', 'buildType'] as const) {
    if (record[field] !== expected[field]) {
      throw new Error(
        `expected frontend ${field}: ${String(expected[field])} | received: ${String(record[field])}`
      );
    }
  }
  if (
    typeof record.builtAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(record.builtAt) ||
    !Number.isFinite(Date.parse(record.builtAt))
  ) {
    throw new Error(
      `expected frontend builtAt: ISO date string | received: ${String(record.builtAt)}`
    );
  }
  return { ...expected, builtAt: record.builtAt };
}
