import type { MessagePart } from '@mangostudio/shared/types';
import { createDiagnosticLogger } from '../../../lib/logger';

const logger = createDiagnosticLogger('messages');

/** Why a stored `messages.parts` value could not be used, without carrying its content. */
export interface CorruptPartsShape {
  reason: 'invalid_json' | 'not_an_array' | 'invalid_element';
  /** UTF-8 length of the stored text. */
  bytes: number;
  /** JSON type of the decoded value, or `unparsable` when it is not JSON. */
  jsonType: string;
  /** Index of the first element that is not a message part, for `invalid_element`. */
  elementIndex?: number;
}

export type DecodedMessageParts =
  | { kind: 'absent' }
  | { kind: 'ok'; parts: MessagePart[] }
  | { kind: 'corrupt'; shape: CorruptPartsShape };

function jsonTypeOf(value: unknown): string {
  if (value === null) return 'null';
  return Array.isArray(value) ? 'array' : typeof value;
}

function isMessagePartLike(value: unknown): value is MessagePart {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return typeof (value as { type?: unknown }).type === 'string';
}

/**
 * Decodes a stored `messages.parts` cell without throwing. A value that is not
 * a JSON array of objects carrying a string `type` is reported as `corrupt`
 * with a content-free description of its shape.
 *
 * Usage: decodeMessageParts('[{"type":"text","text":"hi"}]') // { kind: 'ok', parts: [...] }
 */
export function decodeMessageParts(raw: string | null | undefined): DecodedMessageParts {
  if (!raw) return { kind: 'absent' };

  const bytes = Buffer.byteLength(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'corrupt', shape: { reason: 'invalid_json', bytes, jsonType: 'unparsable' } };
  }

  if (!Array.isArray(parsed)) {
    const shape: CorruptPartsShape = {
      reason: 'not_an_array',
      bytes,
      jsonType: jsonTypeOf(parsed),
    };
    return { kind: 'corrupt', shape };
  }

  const elementIndex = parsed.findIndex((element) => !isMessagePartLike(element));
  if (elementIndex !== -1) {
    const shape: CorruptPartsShape = {
      reason: 'invalid_element',
      bytes,
      jsonType: 'array',
      elementIndex,
    };
    return { kind: 'corrupt', shape };
  }

  return { kind: 'ok', parts: parsed as MessagePart[] };
}

/** Logs one corrupt `messages.parts` cell: the message id and the value's shape, never its content. */
export function warnCorruptMessageParts(messageId: string, shape: CorruptPartsShape): void {
  logger.warn('corrupt_message_parts', { messageId, ...shape });
}

/**
 * Reads a row's parts for a read path that must survive damage. A corrupt cell
 * is logged against the message id and degrades to `undefined`, which callers
 * already treat as "no structured parts, use `text`". Other rows are unaffected.
 *
 * Pass `quiet` when the caller's row was already decoded and logged upstream.
 *
 * Usage: readMessageParts({ id: row.id, parts: row.parts }) // MessagePart[] | undefined
 */
export function readMessageParts(
  row: { id: string; parts: string | null },
  options: { quiet?: boolean } = {}
): MessagePart[] | undefined {
  const decoded = decodeMessageParts(row.parts);
  if (decoded.kind === 'ok') return decoded.parts;
  if (decoded.kind === 'corrupt' && !options.quiet) warnCorruptMessageParts(row.id, decoded.shape);
  return undefined;
}
