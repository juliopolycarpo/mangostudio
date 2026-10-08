import { describe, expect, it } from 'bun:test';
import {
  deleteTomlSectionValue,
  parseTomlDocument,
  setTomlSectionValue,
  stringifyTomlDocument,
} from '../../../src/lib/toml';
import {
  markTomlOffsets,
  prepareTomlOffsets,
  rememberTomlOffsets,
  restoreTomlOffsets,
  tomlOffsetLiteral,
} from '../../../src/lib/toml-offsets';
import { redactSettingsDocument } from '../../../src/modules/library/domain/settings-redaction';

describe('TOML offset compatibility', () => {
  it.each([
    ['1979-05-27T00:32-07:00', '1979-05-27T00:32:00.000-07:00'],
    ['1979-05-27 00:32:00.1-07:00', '1979-05-27T00:32:00.100-07:00'],
    ['1979-05-27t00:32:00.12-07:00', '1979-05-27T00:32:00.120-07:00'],
    ['1979-05-27T00:32:00.123456789-07:00', '1979-05-27T00:32:00.123456789-07:00'],
    ['1979-05-27T07:32:00Z', '1979-05-27T07:32:00.000Z'],
    ['1979-05-27t07:32:00z', '1979-05-27T07:32:00.000Z'],
    ['1979-05-27T07:32:00+00:00', '1979-05-27T07:32:00.000+00:00'],
    ['1979-05-27T07:32:00-00:00', '1979-05-27T07:32:00.000-00:00'],
  ])('preserves the display and save offset for %s', (literal, normalized) => {
    const document = parseTomlDocument(`when = ${literal}`);
    expect(redactSettingsDocument(document, { homeDir: '' })).toEqual([
      { path: 'when', presentation: 'value', value: normalized },
    ]);
    const written = stringifyTomlDocument(document);
    expect(written).toBe(`when = ${normalized}\n`);
    expect(stringifyTomlDocument(parseTomlDocument(written))).toBe(written);
  });

  it('keeps equal instants with distinct offsets in their own fields through edits', () => {
    const document = parseTomlDocument(`
"2" = 1979-05-27T00:32-07:00
"1" = 1979-05-27T08:32+01:00
dates = [1979-05-27T07:32Z, [1979-05-27T07:32-00:00]]
inline = { when = 1979-05-27T09:32+02:00 }
dotted.when = 1979-05-27T02:32-05:00
[nested.table]
when = 1979-05-27T01:32-06:00
[[rows]]
when = 1979-05-27T03:32-04:00
[[rows]]
when = 1979-05-27T04:32-03:00
[auth]
secret = "old"
obsolete = "remove"
`);
    const expected = [
      ['1', '1979-05-27T08:32:00.000+01:00'],
      ['2', '1979-05-27T00:32:00.000-07:00'],
      ['dates[0]', '1979-05-27T07:32:00.000Z'],
      ['dates[1][0]', '1979-05-27T07:32:00.000-00:00'],
      ['inline.when', '1979-05-27T09:32:00.000+02:00'],
      ['dotted.when', '1979-05-27T02:32:00.000-05:00'],
      ['nested.table.when', '1979-05-27T01:32:00.000-06:00'],
      ['rows[0].when', '1979-05-27T03:32:00.000-04:00'],
      ['rows[1].when', '1979-05-27T04:32:00.000-03:00'],
    ];
    setTomlSectionValue(document, 'auth', 'secret', 'new');
    expect(deleteTomlSectionValue(document, 'auth', 'obsolete')).toBe(true);
    const reparsed = parseTomlDocument(stringifyTomlDocument(document));
    for (const [path, value] of expected) {
      expect(redactSettingsDocument(reparsed, { homeDir: '' })).toContainEqual({
        path,
        presentation: 'value',
        value,
      });
    }
  });

  it('ignores date-like text in comments and every string form', () => {
    const document = parseTomlDocument(String.raw`
# 1979-05-27T09:32+02:00 " quote
"1979-05-27T00:32-07:00" = "1979-05-27T00:32-07:00"
escaped = "quote \" 1979-05-27T00:32-07:00 \\"
literal = '1979-05-27T00:32-07:00'
multiline = """first " 1979-05-27T00:32-07:00
escaped \""" still inside
last"""
multiline_literal = '''1979-05-27T00:32-07:00
last'''
when = 1979-05-27T00:32-07:00 # 1979-05-27T09:32+02:00
`);
    const written = parseTomlDocument(stringifyTomlDocument(document));
    for (const [key, value] of Object.entries(document)) {
      if (typeof value === 'string') expect(written[key]).toBe(value);
    }
    expect(redactSettingsDocument(written, { homeDir: '' })).toContainEqual({
      path: 'when',
      presentation: 'value',
      value: '1979-05-27T00:32:00.000-07:00',
    });
  });

  it.each([
    ['"', 4],
    ['"', 5],
    ["'", 4],
    ["'", 5],
  ] as const)('skips multiline %s delimiter runs of %s quotes', (quote, count) => {
    const content = `text = ${quote.repeat(3)}1979-05-27T00:32-07:00${quote.repeat(count)}\nwhen = 1979-05-27T00:32-07:00\n`;
    const doc = parseTomlDocument(content);
    expect(doc.text).toBe(`1979-05-27T00:32-07:00${quote.repeat(count - 3)}`);
    expect(markTomlOffsets(content).zones.size).toBe(1);
    expect(parseTomlDocument(stringifyTomlDocument(doc)).text).toBe(doc.text);
    expect(tomlOffsetLiteral(doc.when)).toBe('1979-05-27T00:32:00.000-07:00');
  });

  it('skips multiline continuation and escaped delimiters before later datetimes', () => {
    const doc = parseTomlDocument(String.raw`
text = """date \
  1979-05-27T00:32-07:00 \\" still text \""" done"""
when = 1979-05-27T00:32-07:00
`);
    expect(typeof doc.text).toBe('string');
    expect(parseTomlDocument(stringifyTomlDocument(doc)).text).toBe(doc.text);
    expect(tomlOffsetLiteral(doc.when)).toBe('1979-05-27T00:32:00.000-07:00');
  });

  it('keeps offset scalar identity when a containing section is spread during an edit', () => {
    const doc = parseTomlDocument('[section]\nwhen = 1979-05-27T00:32-07:00\nold = "remove"');
    const instant = (doc.section as Record<string, unknown>).when;
    setTomlSectionValue(doc, 'section', 'enabled', true);
    expect((doc.section as Record<string, unknown>).when).toBe(instant);
    expect(deleteTomlSectionValue(doc, 'section', 'old')).toBe(true);
    expect((doc.section as Record<string, unknown>).when).toBe(instant);
    expect(stringifyTomlDocument(doc)).toContain('when = 1979-05-27T00:32:00.000-07:00');
  });

  it('avoids collisions with marker-like keys and decoded string values', () => {
    const doc = parseTomlDocument(String.raw`
"__mango_toml_datetime_0" = "__mango_toml_datetime__0"
escaped = "\u005F\u005Fmango_toml_datetime_0"
date = 1979-05-27T00:32-07:00
`);
    const written = stringifyTomlDocument(doc);
    const reparsed = parseTomlDocument(written);
    expect(reparsed.__mango_toml_datetime_0).toBe('__mango_toml_datetime__0');
    expect(reparsed.escaped).toBe('__mango_toml_datetime_0');
    expect(tomlOffsetLiteral(reparsed.date)).toBe('1979-05-27T00:32:00.000-07:00');
    expect(written).toContain('date = 1979-05-27T00:32:00.000-07:00');
  });

  it('associates a marker only with an Instant even when decoded text matches it', () => {
    const content = String.raw`text = "\u005F\u005Fmango_toml_datetime_0"
when = 1979-05-27T00:32-07:00`;
    const original = Bun.TOML.parse(content) as Record<string, unknown>;
    const marked = markTomlOffsets(content);
    expect(marked.zones.has('__mango_toml_datetime_0')).toBe(true);
    rememberTomlOffsets(original, Bun.TOML.parse(marked.content), marked.zones);
    expect(original.text).toBe('__mango_toml_datetime_0');
    expect(tomlOffsetLiteral(original.text)).toBeUndefined();
    expect(tomlOffsetLiteral(original.when)).toBe('1979-05-27T00:32:00.000-07:00');
  });

  it('leaves untracked values and native errors to the native serializer', () => {
    const doc = { date: new Date('1979-05-27T07:32:00Z'), values: [true, 3, 'text'] };
    const prepared = prepareTomlOffsets(doc);
    expect(prepared.document).toBe(doc);
    expect(prepared.literals.size).toBe(0);
    expect(tomlOffsetLiteral(doc.date)).toBeUndefined();
    expect(tomlOffsetLiteral(undefined)).toBeUndefined();
    expect(restoreTomlOffsets('value = "__mango_toml_datetime_0"\n', new Map())).toBe(
      'value = "__mango_toml_datetime_0"\n'
    );
    const cyclic = parseTomlDocument('when = 1979-05-27T00:32-07:00');
    cyclic.self = cyclic;
    expect(() => stringifyTomlDocument(cyclic)).toThrow(/circular/i);
  });

  it('preserves table keys that shadow Object prototype properties', () => {
    const doc = parseTomlDocument('"__proto__".when = 1979-05-27T00:32-07:00');
    const prepared = prepareTomlOffsets(doc);
    expect(prepared.document).not.toBe(doc);
    expect(Object.hasOwn(prepared.document as object, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(prepared.document)).toBe(Object.getPrototypeOf(doc));
    expect(tomlOffsetLiteral((doc.__proto__ as Record<string, unknown>).when)).toBe(
      '1979-05-27T00:32:00.000-07:00'
    );
    expect(stringifyTomlDocument(parseTomlDocument(stringifyTomlDocument(doc)))).toBe(
      stringifyTomlDocument(doc)
    );
  });

  it('reports an unterminated scanner string without exposing its content', () => {
    expect(() => markTomlOffsets('value = "private-fixture-secret')).toThrow(
      'Cannot retain TOML offsets: unterminated string; expected validated TOML.'
    );
  });

  it('rejects an unexpected native scalar rather than silently losing its offset', () => {
    expect(() =>
      rememberTomlOffsets(
        123,
        '__mango_toml_datetime_0',
        new Map([['__mango_toml_datetime_0', 'Z']])
      )
    ).toThrow('Cannot retain TOML offset for [object Number]; expected a native Temporal.Instant.');
  });
});
