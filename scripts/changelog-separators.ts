/**
 * Repair only missing historical release separators; never regenerate history.
 * @example bun run changelog:separators --check
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { normalizeChangelogSeparators } from './lib/changelog';
import { ROOT_DIR } from './lib/config';
import { PROTOCOL_CHANGELOG } from './lib/protocol';
import { fatal } from './lib/runner';

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) {
  fatal('Usage: bun run changelog:separators [--check]');
}
const check = args.includes('--check');
const files = ['CHANGELOG.md', PROTOCOL_CHANGELOG].map((file) => {
  const path = join(ROOT_DIR, file);
  const source = readFileSync(path, 'utf8');
  return { file, path, source, normalized: normalizeChangelogSeparators(source) };
});
for (const { file, path, source, normalized } of files) {
  if (source === normalized) {
    console.log(`${file}: unchanged`);
  } else if (check) {
    console.error(`${file}: missing historical release separators`);
    process.exitCode = 1;
  } else {
    writeFileSync(path, normalized);
    console.log(`${file}: repaired historical release separators`);
  }
}
