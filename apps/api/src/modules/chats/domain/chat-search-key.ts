/**
 * What the chat list's search box matches against, and how both sides of a
 * match are spelled.
 *
 * SQLite's `lower()` folds ASCII only, so the comparison cannot happen in SQL.
 * Every chat instead stores `chats.searchText`, the {@link chatSearchKey} of its
 * title, workdir folder and runner label, and a query is folded with the same
 * {@link foldForSearch} before it is looked for in that column. Whatever the
 * fold does to a letter it does to both sides, so the two never disagree.
 */

/**
 * Folds `text` for an accent- and case-insensitive substring match.
 *
 * Upper-casing and then lower-casing is Unicode full case folding for the
 * scripts that matter here: `ß` becomes `ss`, a final `ς` is restored to `σ`
 * below, and Turkish `İ` and `ı` both land on `i`, so `ISTANBUL` finds `İstanbul`
 * and `ıspanak` alike. The text is then decomposed (NFD) and its combining marks
 * dropped, which turns `ç`, `ã` and `ü` into `c`, `a` and `u` and makes a
 * precomposed letter and its decomposed spelling the same thing.
 *
 * It is lenient by design: marks of scripts that carry meaning in them (Indic
 * vowel signs, for one) are dropped too, on both sides, so such a text is found by
 * a query without them rather than missed.
 *
 * @example
 * foldForSearch('CONFIGURAÇÃO'); // 'configuracao'
 * foldForSearch('Straße'); // 'strasse'
 * foldForSearch('İstanbul'); // 'istanbul'
 */
export function foldForSearch(text: string): string {
  return text
    .toUpperCase()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replaceAll('ς', 'σ');
}

/** Last path segment of a workdir, tolerant of trailing and Windows separators. */
function workdirFolder(workdir: string | null): string {
  if (!workdir) return '';
  const segments = workdir.split(/[\\/]/).filter((segment) => segment.length > 0);
  return segments.at(-1) ?? '';
}

/** The columns of a chat that feed its search text. */
export interface ChatSearchSource {
  title: string;
  workdir: string | null;
  runnerKind: string;
  runnerTargetId: string | null;
}

/**
 * The value stored in `chats.searchText`: the folded title, the folded last
 * segment of the workdir and the folded runner label (`mango` for the built-in
 * runner, the target id for a vendor), the same three fields the sidebar's
 * filter reads. They are joined by a newline, which a search box cannot type, so
 * no match straddles two fields.
 *
 * Every write that changes one of the four source columns has to store this
 * again; `createChat` and `updateChat` in the chat repository are the only
 * writers of those columns.
 *
 * @example
 * chatSearchKey({ title: 'Configuração', workdir: '/srv/Projetos/', runnerKind: 'mangostudio', runnerTargetId: null });
 * // 'configuracao\nprojetos\nmango'
 */
export function chatSearchKey(source: ChatSearchSource): string {
  const runnerLabel = source.runnerKind === 'mangostudio' ? 'mango' : (source.runnerTargetId ?? '');
  return [source.title, workdirFolder(source.workdir), runnerLabel].map(foldForSearch).join('\n');
}
