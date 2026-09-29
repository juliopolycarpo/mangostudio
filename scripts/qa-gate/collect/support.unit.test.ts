import { describe, expect, it } from 'bun:test';

import { errorAnnotations } from './support';

describe('errorAnnotations', () => {
  it('emits one ::error line per message with the title', () => {
    expect(errorAnnotations('QA registry', ['tools/ is unowned', 'lib/ is unowned'])).toBe(
      '::error title=QA registry::tools/ is unowned\n::error title=QA registry::lib/ is unowned\n'
    );
  });

  it('escapes percent signs and newlines so a message cannot start another command', () => {
    expect(errorAnnotations('t', ['50% done\r\n::warning::x'])).toBe(
      '::error title=t::50%25 done%0D%0A::warning::x\n'
    );
  });

  it('emits nothing for no messages', () => {
    expect(errorAnnotations('t', [])).toBe('');
  });
});
