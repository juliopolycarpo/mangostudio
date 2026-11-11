import { renameSync, writeFileSync } from 'node:fs';

/** Synchronous publication operations; tests supply named interruption fakes. */
export interface FixtureJsonFiles {
  readonly write: (path: string, text: string) => void;
  readonly rename: (source: string, destination: string) => void;
}

const FILES: FixtureJsonFiles = { write: writeFileSync, rename: renameSync };

function stageFixtureJson(
  path: string,
  value: Readonly<Record<string, unknown>>,
  files: FixtureJsonFiles
): string {
  const temporary = `${path}.${process.pid}.tmp`;
  files.write(temporary, JSON.stringify(value));
  return temporary;
}

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
  files.rename(stageFixtureJson(path, value, files), path);
}

/** Publish a formatter heartbeat, deferring a Windows rename blocked by a reader.
 * @example publishFormatterHeartbeat('/tmp/formatter.beat', { beat: 2, at: 1234 });
 */
export function publishFormatterHeartbeat(
  path: string,
  value: Readonly<Record<string, unknown>>,
  files: FixtureJsonFiles = FILES,
  platform: NodeJS.Platform = process.platform
): boolean {
  const temporary = stageFixtureJson(path, value, files);
  try {
    files.rename(temporary, path);
    return true;
  } catch (error) {
    // A Windows reader can deny replacement until its handle closes.
    if (
      platform === 'win32' &&
      error instanceof Error &&
      (error as NodeJS.ErrnoException).code === 'EPERM'
    )
      return false;
    throw error;
  }
}
