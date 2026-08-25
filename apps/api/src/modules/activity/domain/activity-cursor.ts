import type { ActivityCursor } from '../infrastructure/activity-repository';

const SEPARATOR = ':';

/**
 * Opaque so the wire never promises a shape the keyset may outgrow.
 *
 * Base64url rather than the raw `createdAt:id` pair for the same reason: a
 * client that can read a cursor eventually builds one, and an offset arithmetic
 * a caller invented is the failure mode keyset pagination exists to avoid.
 */
export function encodeActivityCursor(cursor: ActivityCursor): string {
  return Buffer.from(`${cursor.createdAt}${SEPARATOR}${cursor.id}`, 'utf8').toString('base64url');
}

/** `undefined` for anything this process did not issue; the caller starts at the head. */
export function decodeActivityCursor(raw: string): ActivityCursor | undefined {
  let decoded: string;
  try {
    decoded = Buffer.from(raw, 'base64url').toString('utf8');
  } catch {
    return undefined;
  }

  const separatorIndex = decoded.indexOf(SEPARATOR);
  if (separatorIndex <= 0) return undefined;

  const createdAt = Number(decoded.slice(0, separatorIndex));
  const id = decoded.slice(separatorIndex + 1);
  if (!Number.isSafeInteger(createdAt) || createdAt < 0 || id.length === 0) return undefined;

  return { createdAt, id };
}
