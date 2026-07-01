import { describe, expect, test } from 'bun:test';

import {
  buildCursorHookCommand,
  quoteHookCommandArg,
} from '../../../../../src/services/providers/cursor/hooks';

describe('Cursor hook command quoting', () => {
  test('quotes POSIX hook command paths with spaces', () => {
    expect(
      buildCursorHookCommand(
        '/usr/local/bin/node',
        '/home/jane doe/.mango/cursor-agent/.cursor/hooks/deny-builtins.mjs',
        'linux'
      )
    ).toBe(
      "'/usr/local/bin/node' '/home/jane doe/.mango/cursor-agent/.cursor/hooks/deny-builtins.mjs'"
    );
  });

  test('escapes POSIX single quotes', () => {
    expect(quoteHookCommandArg("/tmp/it's/node", 'linux')).toBe("'/tmp/it'\\''s/node'");
  });

  test('quotes Windows hook command paths with spaces', () => {
    expect(
      buildCursorHookCommand(
        'C:\\Program Files\\nodejs\\node.exe',
        'C:\\Users\\Jane Doe\\.mango\\cursor-agent\\.cursor\\hooks\\deny-builtins.mjs',
        'win32'
      )
    ).toBe(
      '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\Jane Doe\\.mango\\cursor-agent\\.cursor\\hooks\\deny-builtins.mjs"'
    );
  });
});
