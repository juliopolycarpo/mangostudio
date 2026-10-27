/**
 * The revert copy has to be specific about which classes of write it does not
 * cover: a user who only ran MCP tools must not be warned about shell commands,
 * and a turn the manifest fully covered must get no warning at all — a notice
 * on every revert is one people learn to click past.
 *
 * Both locales are asserted because pt-BR is the source of truth for the
 * `Messages` type: a key added to `en` alone type-checks nowhere, and one added
 * to pt-BR alone would render an English string to a Portuguese user.
 */

import { describe, expect, it } from 'bun:test';

import { en, type Messages, ptBR } from '@mangostudio/shared/i18n';

import { revertedMessage, uncheckpointedWarning } from '@/features/chat/lib/uncheckpointed-copy';

const locales: ReadonlyArray<[string, Messages['chat']['fileCheckpoints']]> = [
  ['en', en.chat.fileCheckpoints],
  ['pt-BR', ptBR.chat.fileCheckpoints],
];

describe.each(locales)('uncheckpointedWarning (%s)', (_locale, labels) => {
  it('says nothing when every write was checkpointed', () => {
    expect(uncheckpointedWarning([], labels)).toBeNull();
  });

  it('names only the source that actually ran', () => {
    expect(uncheckpointedWarning(['shell'], labels)).toBe(labels.uncheckpointedShell);
    expect(uncheckpointedWarning(['mcp'], labels)).toBe(labels.uncheckpointedMcp);
    expect(uncheckpointedWarning(['shell'], labels)).not.toBe(labels.uncheckpointedMcp);
  });

  it('uses one combined sentence for both, in either order', () => {
    expect(uncheckpointedWarning(['shell', 'mcp'], labels)).toBe(labels.uncheckpointedBoth);
    expect(uncheckpointedWarning(['mcp', 'shell'], labels)).toBe(labels.uncheckpointedBoth);
  });
});

describe.each(locales)('revertedMessage (%s)', (locale, labels) => {
  it('reports a bare count only when the count is the whole story', () => {
    expect(revertedMessage(3, [], labels, locale)).toBe(
      labels.revertedOther.replace('{count}', '3')
    );
    expect(revertedMessage(1, [], labels, locale)).toBe(labels.revertedOne.replace('{count}', '1'));
  });

  it('restates what the revert left in place', () => {
    expect(revertedMessage(3, ['shell'], labels, locale)).toBe(
      labels.revertedWithShellOther.replace('{count}', '3')
    );
    expect(revertedMessage(3, ['mcp'], labels, locale)).toBe(
      labels.revertedWithMcpOther.replace('{count}', '3')
    );
    expect(revertedMessage(2, ['shell', 'mcp'], labels, locale)).toBe(
      labels.revertedWithBothOther.replace('{count}', '2')
    );
    expect(revertedMessage(1, ['shell'], labels, locale)).toBe(
      labels.revertedWithShellOne.replace('{count}', '1')
    );
    expect(revertedMessage(1, ['mcp'], labels, locale)).toBe(
      labels.revertedWithMcpOne.replace('{count}', '1')
    );
    expect(revertedMessage(1, ['shell', 'mcp'], labels, locale)).toBe(
      labels.revertedWithBothOne.replace('{count}', '1')
    );
  });

  it('interpolates the count into every variant', () => {
    for (const sources of [[], ['shell'], ['mcp'], ['shell', 'mcp']] as const) {
      expect(revertedMessage(7, sources, labels, locale)).toContain('7');
      expect(revertedMessage(7, sources, labels, locale)).not.toContain('{count}');
    }
  });

  it('never prints a "(s)" plural hack', () => {
    for (const sources of [[], ['shell'], ['mcp'], ['shell', 'mcp']] as const) {
      for (const count of [1, 2]) {
        expect(revertedMessage(count, sources, labels, locale)).not.toMatch(/\(\w*s\)/);
      }
    }
  });
});

describe('revertedMessage agreement', () => {
  it('agrees the noun with the count in English', () => {
    expect(revertedMessage(1, [], en.chat.fileCheckpoints, 'en')).toBe('Reverted 1 file.');
    expect(revertedMessage(3, [], en.chat.fileCheckpoints, 'en')).toBe('Reverted 3 files.');
    expect(revertedMessage(0, [], en.chat.fileCheckpoints, 'en')).toBe('Reverted 0 files.');
  });

  it('agrees the noun and the participle with the count in Portuguese', () => {
    expect(revertedMessage(1, [], ptBR.chat.fileCheckpoints, 'pt-BR')).toBe('1 arquivo revertido.');
    expect(revertedMessage(3, [], ptBR.chat.fileCheckpoints, 'pt-BR')).toBe(
      '3 arquivos revertidos.'
    );
  });
});
