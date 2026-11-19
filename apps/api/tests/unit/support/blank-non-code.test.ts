import { describe, expect, test } from 'bun:test';

import { blankNonCode } from '../../support/blank-non-code';

describe('blankNonCode', () => {
  test('blanks line and block comments and keeps the code after them', () => {
    const source = 'a(); // gone\n/* gone\n too */ b();';

    expect(blankNonCode(source)).toBe('a();        \n       \n        b();');
  });

  test('blanks string contents, keeps the quotes, and honors escapes', () => {
    expect(blankNonCode(`x("a\\"b", 'c');`)).toBe(`x("    ", ' ');`);
  });

  test('blanks template text but keeps a ${} expression, including nested braces and templates', () => {
    // eslint-disable-next-line no-template-curly-in-string -- the template literal is source text under scan, not an interpolation.
    const source = 't(`id ${call({ k: `in ${deep}` })} tail`);';

    // eslint-disable-next-line no-template-curly-in-string -- expected source text, not an interpolation.
    expect(blankNonCode(source)).toBe('t(`   ${call({ k: `   ${deep}` })}     `);');
  });

  test('keeps length and newlines so offsets and line numbers still match the original', () => {
    const source = "a('x\ny');\n// c\n`t\nu`;\n";

    const blanked = blankNonCode(source);

    expect(blanked).toHaveLength(source.length);
    expect(blanked.split('\n')).toHaveLength(source.split('\n').length);
  });

  test('stops an unterminated string at the end of its line', () => {
    expect(blankNonCode("a('open\nb();")).toBe("a('    \nb();");
  });
});
