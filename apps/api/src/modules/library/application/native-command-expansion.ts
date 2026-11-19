/**
 * Expands `/name args` into the user's own command template before a native
 * chat turn is built (issue #961).
 *
 * The trust model is the one skills already live under: `~/.mango/commands` is
 * the signed-in user's own directory on the hub's machine, so its files are
 * read as that user's words. What this adds on top is the library's contract
 * for a file it did not author — only a valid instance the `mangostudio` target
 * actually reads is expanded, the read is `O_NOFOLLOW` and size-capped, and any
 * failure falls back to the typed prompt rather than sending the model a
 * half-read template. A name nothing claims is ordinary prose, exactly as in the
 * vendors' CLIs.
 *
 * Hub-local by design, like the skills adapter: a chat bound to another
 * environment still expands from the hub's directory.
 */

import { isBuiltInSlashCommand } from '@mangostudio/shared/library';
import { parseMarkdownFrontmatter } from '@mangostudio/shared/markdown';
import type { Kysely } from 'kysely';

import type { Database } from '../../../db/types';
import { readRegularFileUtf8 } from '../../../lib/safe-file';
import { expandCommandTemplate, parseSlashInvocation } from '../domain/command-template';
import { discoverLibraryResources } from './library-discovery';

export const MAX_COMMAND_FILE_BYTES = 64 * 1024;

const NATIVE_COMMAND_LOCATION_ID = 'mango-commands';

/**
 * The prompt the model should receive for `prompt`: the expanded template when
 * it names one of the user's native commands, otherwise `prompt` unchanged.
 * Never throws for a missing or unreadable command.
 * // Usage: const effectivePrompt = await expandNativeSlashCommand(db, userId, input.prompt);
 */
export async function expandNativeSlashCommand(
  db: Kysely<Database>,
  userId: string,
  prompt: string
): Promise<string> {
  const invocation = parseSlashInvocation(prompt);
  if (!invocation) return prompt;
  // A built-in is the composer's own action; a file of the same name never
  // shadows it, so it is not looked up at all.
  if (isBuiltInSlashCommand(invocation.name)) return prompt;

  // Callers run this before the user message is stored, so nothing below may
  // fail the turn: a broken scan or file is a prompt sent as typed.
  try {
    const scan = await discoverLibraryResources(db, userId, { kinds: ['command'] });
    const resource = scan.resources.find(
      (candidate) => candidate.ref.kind === 'command' && candidate.ref.slug === invocation.name
    );
    const coverage = resource?.coverage.find((entry) => entry.targetId === 'mangostudio');
    if (coverage?.effectiveLocationId !== NATIVE_COMMAND_LOCATION_ID) return prompt;

    const instance = resource?.instances.find(
      (candidate) => candidate.locationId === NATIVE_COMMAND_LOCATION_ID
    );
    if (!instance?.valid) return prompt;

    const { content } = readRegularFileUtf8(instance.path, { maxBytes: MAX_COMMAND_FILE_BYTES });
    const expanded = expandCommandTemplate(parseMarkdownFrontmatter(content).body, invocation.args);
    // A blank template would send the model an empty turn; the typed prompt is
    // at least something it can answer.
    return expanded.trim().length > 0 ? expanded : prompt;
  } catch {
    return prompt;
  }
}
