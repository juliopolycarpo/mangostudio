/**
 * Pass stamps: a local record that one task passed for one exact set of
 * inputs, so an unchanged rerun can skip it.
 *
 * A stamp stores a key and nothing else. No output is saved or restored, which
 * is what keeps this small beside a build cache: the only question it answers
 * is "did this command already exit 0 for these bytes, tools and settings?".
 * The key is a SHA-256 over the content of every input file in the working
 * tree (tracked, modified and untracked alike; a deleted file leaves the list)
 * and over the caller's facts: tool versions, the command, its environment.
 *
 * What keeps a stamp from recording a pass that was never earned:
 *   - only exit 0 is recorded;
 *   - the key is taken before the run and again after it, and a stamp is
 *     written only when both agree, so an edit made while the task ran is not
 *     credited to the run that did not see it;
 *   - an unreadable or malformed stamp is a miss;
 *   - the write is a rename of a complete file.
 *
 * Stamps are off in CI (`passStampsEnabled`): a hosted run is evidence for
 * other people and always executes.
 *
 * @example
 * const result = await runWithPassStamp({
 *   label: 'rust:nextest',
 *   stampDir,
 *   enabled: !process.env.CI,
 *   key: () => passStampKey(ROOT_DIR, { files, facts }),
 *   run: () => runCommand('rust:nextest', cmd),
 * });
 */

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { RunResult } from './exec';
import { dim } from './log';

/** Where stamps live, repository-relative. Gitignored with the rest of `.mango`. */
export const PASS_STAMP_DIR = '.mango/pass-stamps';

/**
 * Whether a run may read and write stamps: never with `--force`, never in CI.
 *
 * @example
 * passStampsEnabled(false, { CI: 'true' }); // false
 */
export function passStampsEnabled(
  force: boolean,
  env: Readonly<Record<string, string | undefined>> = process.env
): boolean {
  return !force && !env.CI?.trim();
}

/** Bump when the key's layout changes, so every older stamp misses. */
const STAMP_SCHEMA = 1;

export interface PassStampInputs {
  /** Repository-relative POSIX paths. A path that is not a regular file is skipped. */
  readonly files: readonly string[];
  /** Everything else the result depends on: versions, command, environment. */
  readonly facts: Readonly<Record<string, string>>;
}

/**
 * The key for one set of inputs: file paths and bytes, then the facts, each in
 * sorted order so the same inputs give the same key however they were listed.
 *
 * @example
 * passStampKey('/repo', { files: ['Cargo.lock'], facts: { cargo: 'cargo 1.99.0' } });
 */
export function passStampKey(rootDir: string, inputs: PassStampInputs): string {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(`pass-stamp ${STAMP_SCHEMA}\n`);
  for (const file of [...new Set(inputs.files)].sort()) {
    const path = join(rootDir, file);
    // A directory or a dangling symlink in the listing carries no bytes to hash.
    if (!statSync(path, { throwIfNoEntry: false })?.isFile()) continue;
    const content = new Bun.CryptoHasher('sha256').update(readFileSync(path)).digest('hex');
    hasher.update(`file ${JSON.stringify(file)} ${content}\n`);
  }
  for (const name of Object.keys(inputs.facts).sort()) {
    hasher.update(`fact ${JSON.stringify(name)} ${JSON.stringify(inputs.facts[name])}\n`);
  }
  return hasher.digest('hex');
}

function stampPath(stampDir: string, label: string): string {
  return join(stampDir, `${label.replaceAll(/[^A-Za-z0-9._-]/g, '_')}.json`);
}

/**
 * The key the task last passed with, or null when there is no usable stamp.
 *
 * @example
 * readPassStamp('.mango/pass-stamps', 'rust:nextest'); // 'ab12…' | null
 */
export function readPassStamp(stampDir: string, label: string): string | null {
  try {
    const stamp: unknown = JSON.parse(readFileSync(stampPath(stampDir, label), 'utf8'));
    if (typeof stamp !== 'object' || stamp === null) return null;
    const { schema, label: stamped, key } = stamp as Record<string, unknown>;
    if (schema !== STAMP_SCHEMA || stamped !== label) return null;
    return typeof key === 'string' && /^[0-9a-f]{64}$/.test(key) ? key : null;
  } catch {
    // Missing, unreadable or not JSON: run the task.
    return null;
  }
}

/** Record that `label` passed with `key`, replacing any earlier stamp. */
export function writePassStamp(stampDir: string, label: string, key: string): void {
  mkdirSync(stampDir, { recursive: true });
  const path = stampPath(stampDir, label);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ schema: STAMP_SCHEMA, label, key })}\n`);
  renameSync(temporary, path);
}

export interface PassStampRun {
  readonly label: string;
  readonly stampDir: string;
  /** False runs the task and neither reads nor writes a stamp. */
  readonly enabled: boolean;
  readonly key: () => string | Promise<string>;
  readonly run: () => Promise<RunResult>;
  /** Where the replay and no-stamp lines go; the runner's dim console line by default. */
  readonly report?: (message: string) => void;
}

/**
 * Run a task unless it already passed with the current key. A replayed result
 * says so in its label, with the key it matched, so a summary never shows a
 * skipped task as one that ran.
 *
 * @example
 * (await runWithPassStamp(stamped)).label; // 'rust:nextest (replayed ab12cd34ef56)'
 */
export async function runWithPassStamp(stamped: PassStampRun): Promise<RunResult> {
  if (!stamped.enabled) return stamped.run();
  const report = stamped.report ?? dim;
  const before = await stamped.key();
  const short = before.slice(0, 12);
  if (readPassStamp(stamped.stampDir, stamped.label) === before) {
    report(`  ${stamped.label}: passed before with inputs ${short}; pass --force to run it`);
    return { label: `${stamped.label} (replayed ${short})`, exitCode: 0, duration: 0 };
  }
  const result = await stamped.run();
  if (result.exitCode !== 0) return result;
  const after = await stamped.key();
  if (after === before) writePassStamp(stamped.stampDir, stamped.label, before);
  else {
    report(
      `  ${stamped.label}: inputs changed during the run ` +
        `(${short} to ${after.slice(0, 12)}); pass not recorded`
    );
  }
  return result;
}
