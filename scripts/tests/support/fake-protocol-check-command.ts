/**
 * Records protocol checker subprocesses without running their external tools.
 * Compiled as `bun` and `turbo` so the real CLI exercises its normal PATH lookup.
 * @example PROTOCOL_CHECK_RECORDS=/fixture/records turbo run check:quick
 */
import { writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const directory = process.env.PROTOCOL_CHECK_RECORDS;
if (!directory)
  throw new Error(
    'fake protocol command: expected PROTOCOL_CHECK_RECORDS directory; received unset'
  );
const tool = basename(process.execPath).replace(/\.exe$/i, '');
const args = process.argv.slice(2);
const allowedScripts = new Set([
  './scripts/protocol/check-versions.ts',
  './scripts/protocol/verify-spec.ts',
  './scripts/protocol/verify-schema-equality.ts',
  './scripts/protocol/fixtures/generate-chunks.ts',
  './scripts/protocol/fixtures/generate-ssh-argv.ts',
  './scripts/protocol/fixtures/generate-catalog-example.ts',
]);
if (
  (tool === 'turbo' && args[0] !== 'run') ||
  (tool === 'bun' && !allowedScripts.has(args[0] ?? ''))
)
  throw new Error(`fake protocol command: unexpected ${tool} arguments ${JSON.stringify(args)}`);
if (tool !== 'bun' && tool !== 'turbo')
  throw new Error(`fake protocol command: expected bun | turbo; received ${tool}`);
writeFileSync(join(directory, `${process.pid}.json`), JSON.stringify({ tool, args }));
