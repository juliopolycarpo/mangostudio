/**
 * Repair only missing historical release separators; never regenerate history.
 * @example bun run changelog:separators --check
 */
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
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

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) {
  fatal('Usage: bun run changelog:separators [--check]');
}
const check = args.includes('--check');
const root = realpathSync(ROOT_DIR);
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const files = ['CHANGELOG.md', PROTOCOL_CHANGELOG].map((file) => {
  const path = join(root, file);
  const metadata = lstatSync(path);
  if (!metadata.isFile() || realpathSync(path) !== path) {
    fatal(`${file}: expected a regular file at its repository path.`);
  }
  const bytes = readFileSync(path);
  let source: string;
  try {
    source = decoder.decode(bytes);
  } catch {
    fatal(`${file}: expected valid UTF-8. No changelogs were written.`);
  }
  return {
    file,
    path,
    mode: metadata.mode & 0o777,
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
      renameSync(temporaryFile, path);
    } finally {
      rmSync(temporaryDir, { recursive: true, force: true });
    }
    console.log(`${file}: repaired historical release separators`);
  }
}
