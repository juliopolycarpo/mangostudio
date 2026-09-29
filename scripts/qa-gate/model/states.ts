// Explicit data states for every QA measurement.
//
// A measurement is never a bare number that could be a silent zero. It is one
// of five states, and only `measured` and `partial` carry a value at all:
//
//   measured     the collector observed the value for this commit
//   partial      a value exists but part of the input could not be read; the
//                reasons say what is missing, and the value is a lower bound
//   stale        data exists but describes a different commit
//   unavailable  the collector or its producer failed, was canceled, or the
//                input is missing
//   unsupported  the metric is not defined (yet) for this component
//
// `stale`, `unavailable` and `unsupported` have no `value` field, so nothing
// downstream can read a zero (or a "success") out of them.

import Type, { type TSchema } from 'typebox';

export const DATA_STATES = ['measured', 'partial', 'stale', 'unavailable', 'unsupported'] as const;
export type DataState = (typeof DATA_STATES)[number];

/** Bound for the reason list and each reason: artifact text is untrusted. */
export const MAX_REASONS = 20;
export const MAX_REASON_LENGTH = 400;

const reasonsSchema = Type.Array(Type.String({ minLength: 1, maxLength: MAX_REASON_LENGTH }), {
  minItems: 1,
  maxItems: MAX_REASONS,
});

/**
 * Schema for a measurement whose measured value has the given shape.
 * // Usage: const cell = measurement(Type.Integer({ minimum: 0 }));
 */
export const measurement = <T extends TSchema>(value: T) =>
  Type.Union([
    Type.Object({ state: Type.Literal('measured'), value }, { additionalProperties: false }),
    Type.Object(
      { state: Type.Literal('partial'), value, reasons: reasonsSchema },
      { additionalProperties: false }
    ),
    Type.Object(
      { state: Type.Literal('stale'), reasons: reasonsSchema },
      { additionalProperties: false }
    ),
    Type.Object(
      { state: Type.Literal('unavailable'), reasons: reasonsSchema },
      { additionalProperties: false }
    ),
    Type.Object(
      { state: Type.Literal('unsupported'), reasons: reasonsSchema },
      { additionalProperties: false }
    ),
  ]);

/** A measurement of `T`; the generic form of what `measurement(schema)` validates. */
export type Measurement<T> =
  | { state: 'measured'; value: T }
  | { state: 'partial'; value: T; reasons: string[] }
  | { state: 'stale'; reasons: string[] }
  | { state: 'unavailable'; reasons: string[] }
  | { state: 'unsupported'; reasons: string[] };

const clip = (reason: string): string => reason.slice(0, MAX_REASON_LENGTH) || 'no reason recorded';
const clipAll = (reasons: string | readonly string[]): string[] =>
  (typeof reasons === 'string' ? [reasons] : [...reasons]).slice(0, MAX_REASONS).map(clip);

/** A value the collector observed. // Usage: measured({ files: 3 }) */
export const measured = <T>(value: T): Measurement<T> => ({ state: 'measured', value });

/** A lower-bound value with the reasons part of the input was unreadable. */
export const partial = <T>(value: T, reasons: string | readonly string[]): Measurement<T> => ({
  state: 'partial',
  value,
  reasons: clipAll(reasons),
});

/** Data that describes a different commit than the envelope's source SHA. */
export const stale = <T>(reasons: string | readonly string[]): Measurement<T> => ({
  state: 'stale',
  reasons: clipAll(reasons),
});

/** A measurement the collector could not obtain. */
export const unavailable = <T>(reasons: string | readonly string[]): Measurement<T> => ({
  state: 'unavailable',
  reasons: clipAll(reasons),
});

/** A metric that is not defined for the component it was asked of. */
export const unsupported = <T>(reasons: string | readonly string[]): Measurement<T> => ({
  state: 'unsupported',
  reasons: clipAll(reasons),
});

/** Why the producer of an input left nothing usable behind. */
export type ProducerAbsence = 'missing' | 'failed' | 'canceled' | 'skipped';

/**
 * Explicit state for data whose producer never delivered it. A canceled,
 * failed, skipped or absent producer is `unavailable`, never a zero or a pass.
 * // Usage: absentFromProducer('test metrics fragment', 'canceled')
 */
export const absentFromProducer = <T>(what: string, cause: ProducerAbsence): Measurement<T> =>
  unavailable(`${what} not delivered: producer ${cause}`);

/** The value of a fully `measured` measurement; null for every other state. */
export const measuredValue = <T>(cell: Measurement<T> | null | undefined): T | null =>
  cell?.state === 'measured' ? cell.value : null;

/** True for the states that mean data should have been there and was not trustworthy. */
export const needsAttention = (cell: Measurement<unknown>): boolean =>
  cell.state === 'partial' || cell.state === 'stale' || cell.state === 'unavailable';

/** Human-readable `state (reasons)` text for report cells and notes. */
export const describeState = (cell: Measurement<unknown>): string => {
  if (cell.state === 'measured') return 'measured';
  return `${cell.state}: ${cell.reasons.join('; ')}`;
};
