import { describe, expect, it } from 'bun:test';

import { decodeClixml } from '../../../src/machine/powershell-output';
import { CAPTURED_PROGRESS_THEN_THROW, CAPTURED_PROGRESS_THEN_THROW_TEXT } from './clixml-captures';

describe('decodeClixml', () => {
  it('turns a captured PowerShell 5.1 envelope into the error text and drops the progress record', () => {
    const plain = decodeClixml(CAPTURED_PROGRESS_THEN_THROW);
    expect(plain).toBe(CAPTURED_PROGRESS_THEN_THROW_TEXT);
    expect(plain).not.toMatch(/CLIXML|<Objs|Preparando/);
  });

  it('keeps text outside an envelope, in order', () => {
    const text =
      'native line\r\n#< CLIXML\r\n<Objs><S S="Error">boom_x000D__x000A_</S></Objs>trailing';
    expect(decodeClixml(text)).toBe('native line\r\nboom\r\ntrailing');
  });

  it('returns text without an envelope unchanged', () => {
    const text = 'exit 3: access is denied\r\n_x0041_ & <not xml>';
    expect(decodeClixml(text)).toBe(text);
  });

  it('decodes a progress-only envelope to nothing', () => {
    const text =
      '#< CLIXML\r\n<Objs><Obj S="progress" RefId="0"><MS><PR N="Record"><AV>act</AV></PR></MS></Obj></Objs>';
    expect(decodeClixml(text)).toBe('');
  });

  it('undoes XML entities and code unit escapes, including a surrogate pair', () => {
    const text =
      '#< CLIXML\r\n<Objs><S S="Error">a &lt;b&gt; &amp; &quot;c&quot; &apos;d&apos; &#65;&#x42; snake_x005F_case _x0041_ _xD83D__xDE00_ _xZZZZ_ _x00</S></Objs>';
    expect(decodeClixml(text)).toBe('a <b> & "c" \'d\' AB snake_case A \u{1F600} _xZZZZ_ _x00');
  });

  it('removes the colour escapes PowerShell 7 puts in its error text', () => {
    const text =
      '#< CLIXML\r\n<Objs><S S="Error">_x001B_[31;1mException: _x001B_[31;1mboom-throw_x001B_[0m_x000D__x000A_</S></Objs>';
    expect(decodeClixml(text)).toBe('Exception: boom-throw\r\n');
  });

  it('decodes an envelope cut short as far as it goes', () => {
    const text = '#< CLIXML\r\n<Objs><S S="Error">first_x000D__x000A_</S><S S="Error">secon';
    expect(decodeClixml(text)).toBe('first\r\nsecon');
  });

  it('decodes two envelopes independently', () => {
    const text =
      '#< CLIXML\r\n<Objs><S S="Error">one </S></Objs>#< CLIXML\r\n<Objs><S S="Error">two</S></Objs>';
    expect(decodeClixml(text)).toBe('one two');
  });
});
