import { describe, expect, it } from 'bun:test';

import {
  chatSearchKey,
  foldForSearch,
} from '../../../../../src/modules/chats/domain/chat-search-key';

describe('foldForSearch', () => {
  it('folds case and accents so every spelling of a Portuguese word agrees', () => {
    for (const spelling of ['Configuração', 'CONFIGURAÇÃO', 'configuração', 'configuracao']) {
      expect(foldForSearch(spelling), `(${spelling}): expected folded: configuracao`).toBe(
        'configuracao'
      );
    }
  });

  it('treats a decomposed accent as the precomposed letter', () => {
    expect(foldForSearch('Configurac\u0327a\u0303o')).toBe(foldForSearch('Configuração'));
  });

  it('folds Turkish dotted and dotless i onto i', () => {
    expect(foldForSearch('İstanbul')).toBe('istanbul');
    expect(foldForSearch('ISTANBUL')).toBe('istanbul');
    expect(foldForSearch('ıspanak')).toBe('ispanak');
    expect(foldForSearch('ISPANAK')).toBe('ispanak');
  });

  it('folds German sharp s onto ss and umlauts onto the base letter', () => {
    expect(foldForSearch('Straße')).toBe('strasse');
    expect(foldForSearch('STRASSE')).toBe('strasse');
    expect(foldForSearch('MÜLLER')).toBe('muller');
  });

  it('folds Greek final sigma onto sigma, so a word is found from either end', () => {
    expect(foldForSearch('ΣΑΣ')).toBe(foldForSearch('σασ'));
    expect(foldForSearch('σας')).toBe('σασ');
  });

  it('expands a ligature the way full case folding does', () => {
    expect(foldForSearch('ﬁnal')).toBe('final');
  });

  it('leaves characters that are neither cased nor marked alone, newline included', () => {
    expect(foldForSearch('100% a_b\nc-d 日本語')).toBe('100% a_b\nc-d 日本語');
  });

  it('is idempotent', () => {
    const once = foldForSearch('Ὀδυσσεύς İstanbul Straße');
    expect(foldForSearch(once)).toBe(once);
  });

  it('reduces marks alone to nothing', () => {
    expect(foldForSearch('\u0301\u0327')).toBe('');
  });
});

describe('chatSearchKey', () => {
  const native = { runnerKind: 'mangostudio', runnerTargetId: null } as const;

  it('joins the folded title, workdir folder and runner label by newlines', () => {
    expect(
      chatSearchKey({ title: 'Configuração', workdir: '/srv/Projetos/Relatório', ...native })
    ).toBe('configuracao\nrelatorio\nmango');
  });

  it('names the target of a vendor runner and ignores the agent', () => {
    expect(
      chatSearchKey({
        title: 't',
        workdir: null,
        runnerKind: 'external',
        runnerTargetId: 'Codex',
      })
    ).toBe('t\n\ncodex');
  });

  it('reads the last folder through trailing and Windows separators', () => {
    expect(chatSearchKey({ title: '', workdir: '/srv/ledger/', ...native })).toBe(
      '\nledger\nmango'
    );
    expect(chatSearchKey({ title: '', workdir: 'C:\\work\\Harbor', ...native })).toBe(
      '\nharbor\nmango'
    );
  });

  it('has an empty folder for no workdir and for one that is all separators', () => {
    expect(chatSearchKey({ title: 't', workdir: null, ...native })).toBe('t\n\nmango');
    expect(chatSearchKey({ title: 't', workdir: '///', ...native })).toBe('t\n\nmango');
  });

  it('has an empty runner label for an external chat without a target', () => {
    expect(
      chatSearchKey({ title: 't', workdir: null, runnerKind: 'external', runnerTargetId: null })
    ).toBe('t\n\n');
  });
});
