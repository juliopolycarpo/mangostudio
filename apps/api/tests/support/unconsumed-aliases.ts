import { readSourceFileBatches } from './source-file-batches';

/** Paths read per round; each round still reads in the bounded batches of `readSourceFileBatches`. */
const ROUND_SIZE = 64;

/**
 * The aliases that no file in `paths` mentions as a whole word.
 *
 * Detection matches `\bAlias\b` in any file, as a per-alias scan would. The cost differs:
 * one alternation regex covers every alias per file, and reading stops as soon as every
 * alias has a consumer. A live set is therefore decided by the first files that name each
 * alias, and only a dead alias makes the scan read every path. Put the likeliest
 * consumers first in `paths`.
 *
 * Aliases must be `\w+` identifiers; they are placed in a RegExp unescaped.
 *
 * @example
 * const dead = await findUnconsumedAliases(['FooSelect'], ['a.ts'], (path) => Bun.file(path).text());
 */
export async function findUnconsumedAliases(
  aliases: readonly string[],
  paths: readonly string[],
  read: (path: string) => Promise<string>
): Promise<string[]> {
  const pending = new Set(aliases);
  if (pending.size === 0) return [];
  const aliasPattern = new RegExp(`\\b(?:${[...pending].join('|')})\\b`, 'g');

  for (let offset = 0; offset < paths.length && pending.size > 0; offset += ROUND_SIZE) {
    const texts = await readSourceFileBatches(paths.slice(offset, offset + ROUND_SIZE), read);
    for (const text of texts) {
      for (const match of text.matchAll(aliasPattern)) pending.delete(match[0]);
    }
  }

  // Keep the caller's order, so a failure lists aliases as db/types.ts declares them.
  return aliases.filter((alias) => pending.has(alias));
}
