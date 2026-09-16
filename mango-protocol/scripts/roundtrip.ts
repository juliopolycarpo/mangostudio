/**
 * The pure half of `verify-roundtrip.ts`: which corpus lines cross to the
 * other implementation, and how its answers are judged.
 *
 * A line the TypeScript SDK accepts must come back `OK` with a frame that
 * decodes to the same value; a line it refuses must come back `ERR` with the
 * same reason. Implementation-defined cases are sent but never judged.
 *
 * @example
 * const cases = roundTripCases(frames.cases);
 * const failures = judgeAnswers(cases, answers);
 */

import { isSubset } from './subset';

export interface RoundTripCase {
  readonly name: string;
  /** The NDJSON line sent to the other side, without its terminator. */
  readonly line: string;
  /** What the other side must answer; `undefined` for implementation-defined cases. */
  readonly expectation?:
    | { readonly kind: 'ok'; readonly value: unknown }
    | { readonly kind: 'err'; readonly reason: string };
}

export interface CorpusCase {
  readonly name: string;
  readonly verdict: 'accept' | 'reject' | 'implementation-defined';
  readonly line: string;
  readonly expected?: unknown;
  readonly reason?: string;
}

/** An answer line from the other side, `OK<TAB>json` or `ERR<TAB>reason`. */
export type Answer =
  | { readonly kind: 'ok'; readonly line: string }
  | { readonly kind: 'err'; readonly reason: string };

/**
 * Turns the frame corpus into round-trip cases. Lines with a raw newline
 * inside cannot travel as one NDJSON record and are skipped.
 *
 * @example
 * roundTripCases([{ name: 'y_ping', verdict: 'accept', line: '{"type":"ping"}' }]);
 */
export function roundTripCases(cases: readonly CorpusCase[]): RoundTripCase[] {
  return cases
    .filter((entry) => !entry.line.includes('\n') && entry.line.trim() !== '')
    .map((entry) => {
      if (entry.verdict === 'accept') {
        return {
          name: entry.name,
          line: entry.line,
          expectation: { kind: 'ok', value: entry.expected },
        };
      }
      if (entry.verdict === 'reject' && entry.reason !== undefined) {
        return {
          name: entry.name,
          line: entry.line,
          expectation: { kind: 'err', reason: entry.reason },
        };
      }
      return { name: entry.name, line: entry.line };
    });
}

/**
 * Parses one answer line from the other side.
 *
 * @example
 * parseAnswer('OK\t{"type":"ping"}'); // { kind: 'ok', line: '{"type":"ping"}' }
 */
export function parseAnswer(text: string): Answer {
  const tab = text.indexOf('\t');
  const head = tab === -1 ? text : text.slice(0, tab);
  const rest = tab === -1 ? '' : text.slice(tab + 1);
  if (head === 'OK') return { kind: 'ok', line: rest };
  if (head === 'ERR') return { kind: 'err', reason: rest };
  throw new Error(
    `answer "${text.slice(0, 40)}" is malformed; expected OK<TAB>frame or ERR<TAB>reason`
  );
}

/**
 * Judges the other side's answers against the cases, in order. `decode`
 * turns an accepted answer's frame text back into a value with this side's
 * decoder, so both directions are proven at once.
 *
 * @example
 * judgeAnswers(cases, answers, (line) => JSON.parse(line)); // [] when every answer agrees
 */
export function judgeAnswers(
  cases: readonly RoundTripCase[],
  answers: readonly Answer[],
  decode: (line: string) => unknown
): string[] {
  if (answers.length !== cases.length) {
    return [`expected ${cases.length} answers, received ${answers.length}`];
  }
  const failures: string[] = [];
  cases.forEach((entry, index) => {
    const answer = answers[index];
    if (!answer || !entry.expectation) return;
    const failure = judgeOne(entry, answer, decode);
    if (failure) failures.push(`${entry.name}: ${failure}`);
  });
  return failures;
}

function judgeOne(
  entry: RoundTripCase,
  answer: Answer,
  decode: (line: string) => unknown
): string | undefined {
  const expectation = entry.expectation;
  if (!expectation) return undefined;
  if (expectation.kind === 'err') {
    if (answer.kind !== 'err')
      return `expected a refusal (${expectation.reason}), received an accepted frame`;
    return answer.reason === expectation.reason
      ? undefined
      : `expected refusal reason ${expectation.reason}, received ${answer.reason}`;
  }
  if (answer.kind !== 'ok') return `expected an accepted frame, received refusal ${answer.reason}`;
  let decoded: unknown;
  try {
    decoded = decode(answer.line);
  } catch (error) {
    return `the re-encoded frame does not decode here: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (expectation.value !== undefined && !isSubset(expectation.value, decoded)) {
    return `re-encoded frame ${answer.line} does not carry the expected members`;
  }
  return undefined;
}
