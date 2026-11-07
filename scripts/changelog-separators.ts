/**
 * Repair only missing historical release separators; never regenerate history.
 * @example bun run changelog:separators --check
 */
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { fatal } from './lib/args';
import { normalizeChangelogSeparators } from './lib/changelog';
import { ROOT_DIR } from './lib/config';
import { PROTOCOL_CHANGELOG } from './lib/protocol';

const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

// Validate the open descriptor against the canonical repository entry before
// reading. A path replacement cannot change which file readFileSync reads.
function readRepositoryChangelog(path: string): { bytes: Buffer; mode: number } | null {
  let fd: number;
  try {
    fd = openSync(path, READ_FLAGS);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ELOOP' || code === 'EISDIR') return null;
    throw error;
  }
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || realpathSync(path) !== path) return null;
    const entry = lstatSync(path, { bigint: true });
    if (!entry.isFile() || opened.dev !== entry.dev || opened.ino !== entry.ino) {
      return null;
    }
    return { bytes: readFileSync(fd), mode: Number(opened.mode & 0o777n) };
  } finally {
    closeSync(fd);
  }
}

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) {
  fatal('Usage: bun run changelog:separators [--check]');
}
const check = args.includes('--check');
const root = realpathSync(ROOT_DIR);
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const files = ['CHANGELOG.md', PROTOCOL_CHANGELOG].map((file) => {
  const path = join(root, file);
  const input = readRepositoryChangelog(path);
  if (!input) fatal(`${file}: expected a regular file at its repository path.`);
  let source: string;
  try {
    source = decoder.decode(input.bytes);
  } catch {
    fatal(`${file}: expected valid UTF-8. No changelogs were written.`);
  }
  return {
    file,
    path,
    mode: input.mode,
    source,
    normalized: normalizeChangelogSeparators(source),
  };
});
for (const { file, path, mode, source, normalized } of files) {
  if (source === normalized) {
    console.log(`${file}: unchanged`);
  } else if (check) {
    console.error(`${file}: missing historical release separators`);
    process.exitCode = 1;
  } else {
    const temporaryDir = mkdtempSync(join(dirname(path), '.changelog-repair-'));
    const temporaryFile = join(temporaryDir, 'repaired.md');
    try {
      writeFileSync(temporaryFile, normalized, { mode: 0o600 });
      chmodSync(temporaryFile, mode);
      const current = readRepositoryChangelog(path);
      if (current?.mode !== mode || !current.bytes.equals(Buffer.from(source))) {
        throw new Error(`${file}: changed during repair. Run the command again.`);
      }
      renameSync(temporaryFile, path);
    } finally {
      rmSync(temporaryDir, { recursive: true, force: true });
    }
    console.log(`${file}: repaired historical release separators`);
  }
}
