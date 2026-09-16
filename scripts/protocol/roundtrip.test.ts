import { describe, expect, it } from 'bun:test';
import { type CorpusCase, judgeAnswers, parseAnswer, roundTripCases } from './roundtrip';
import { isSubset } from './subset';

const corpus: readonly CorpusCase[] = [
  { name: 'y_ping', verdict: 'accept', line: '{"type":"ping"}', expected: { type: 'ping' } },
  { name: 'n_bad', verdict: 'reject', line: '{"type":"nope"}', reason: 'schema' },
  { name: 'n_json', verdict: 'reject', line: '{', reason: 'invalid-json' },
  { name: 'i_dup', verdict: 'implementation-defined', line: '{"type":"ping","type":"ping"}' },
  { name: 'n_newline', verdict: 'reject', line: '{"a":\n1}', reason: 'schema' },
];

describe('roundTripCases', () => {
  it('keeps every single-line case and records what the other side must answer', () => {
    const cases = roundTripCases(corpus);
    expect(cases.map((entry) => entry.name)).toEqual(['y_ping', 'n_bad', 'n_json', 'i_dup']);
    expect(cases[0]?.expectation).toEqual({ kind: 'ok', value: { type: 'ping' } });
    expect(cases[1]?.expectation).toEqual({ kind: 'err', reason: 'schema' });
    expect(cases[3]?.expectation).toBeUndefined();
  });
});

describe('parseAnswer', () => {
  it('reads OK and ERR answers', () => {
    expect(parseAnswer('OK\t{"type":"ping"}')).toEqual({ kind: 'ok', line: '{"type":"ping"}' });
    expect(parseAnswer('ERR\tschema')).toEqual({ kind: 'err', reason: 'schema' });
  });

  it('names a malformed answer', () => {
    expect(() => parseAnswer('WHAT')).toThrow(
      'answer "WHAT" is malformed; expected OK<TAB>frame or ERR<TAB>reason'
    );
  });
});

describe('isSubset', () => {
  it('allows extra members but not different or missing ones', () => {
    expect(isSubset({ a: 1 }, { a: 1, b: 2 })).toBe(true);
    expect(isSubset({ a: 1 }, { a: 2 })).toBe(false);
    expect(isSubset([1, 2], [1])).toBe(false);
  });
});

describe('judgeAnswers', () => {
  const cases = roundTripCases(corpus);
  const decode = (line: string): unknown => JSON.parse(line);

  it('passes when every answer agrees', () => {
    const answers = [
      parseAnswer('OK\t{"type":"ping","x-extra":true}'),
      parseAnswer('ERR\tschema'),
      parseAnswer('ERR\tinvalid-json'),
      parseAnswer('ERR\tschema'),
    ];
    expect(judgeAnswers(cases, answers, decode)).toEqual([]);
  });

  it('reports a count mismatch, a wrong verdict, a wrong reason and a changed frame', () => {
    expect(judgeAnswers(cases, [], decode)).toEqual(['expected 4 answers, received 0']);
    const answers = [
      parseAnswer('OK\t{"type":"pong"}'),
      parseAnswer('OK\t{"type":"nope"}'),
      parseAnswer('ERR\tschema'),
      parseAnswer('OK\t{}'),
    ];
    expect(judgeAnswers(cases, answers, decode)).toEqual([
      'y_ping: re-encoded frame {"type":"pong"} does not carry the expected members',
      'n_bad: expected a refusal (schema), received an accepted frame',
      'n_json: expected refusal reason invalid-json, received schema',
    ]);
  });

  it('reports an answer this side cannot decode', () => {
    const failing = (): unknown => {
      throw new Error('not a frame');
    };
    expect(judgeAnswers(cases.slice(0, 1), [parseAnswer('OK\t{}')], failing)).toEqual([
      'y_ping: the re-encoded frame does not decode here: not a frame',
    ]);
  });
});
