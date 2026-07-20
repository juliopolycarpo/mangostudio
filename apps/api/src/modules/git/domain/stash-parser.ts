import type { StashEntry } from '@mangostudio/shared/git';

const STASH_SELECTOR_PATTERN = /^stash@\{(\d+)}$/;
const STASH_SUBJECT_PATTERN = /^(?:On|WIP on) ([^:]+): (.*)$/;

/** Parses `git stash list --format=%gd%x00%gs` without depending on locale. */
export function parseStashList(output: string): StashEntry[] {
  const stashes: StashEntry[] = [];

  for (const record of output.split('\n')) {
    if (!record) continue;
    const separator = record.indexOf('\0');
    if (separator < 0) continue;

    const selector = record.slice(0, separator);
    const indexMatch = STASH_SELECTOR_PATTERN.exec(selector);
    if (!indexMatch) continue;

    const subject = record.slice(separator + 1);
    const subjectMatch = STASH_SUBJECT_PATTERN.exec(subject);
    stashes.push(
      subjectMatch
        ? { index: Number(indexMatch[1]), branch: subjectMatch[1], message: subjectMatch[2] }
        : { index: Number(indexMatch[1]), message: subject }
    );
  }

  return stashes;
}
