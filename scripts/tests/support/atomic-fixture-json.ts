import { renameSync, writeFileSync } from 'node:fs';

/** Synchronous publication operations; tests supply named interruption fakes. */
export interface FixtureJsonFiles {
  readonly write: (path: string, text: string) => void;
  readonly rename: (source: string, destination: string) => void;
}

const FILES: FixtureJsonFiles = { write: writeFileSync, rename: renameSync };

/**
 * Publish complete fixture JSON with a same-directory rename. A terminated or
 * failed staging write leaves the previous document intact. The owning test
 * directory removes abandoned staging files after its children have settled.
 *
 * @example
 * publishFixtureJson('/tmp/formatter.beat', { beat: 2, at: 1234 });
 */
export function publishFixtureJson(
  path: string,
  value: Readonly<Record<string, unknown>>,
  files: FixtureJsonFiles = FILES
): void {
  const temporary = `${path}.${process.pid}.tmp`;
  files.write(temporary, JSON.stringify(value));
  files.rename(temporary, path);
}
