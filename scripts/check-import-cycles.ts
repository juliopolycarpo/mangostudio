import { relative, resolve } from 'node:path';

import { ROOT_DIR } from './lib/config';
import { scanImportCycles } from './lib/import-cycles';

const arguments_ = process.argv.slice(2);
const json = arguments_[0] === '--json';
const requested = json ? arguments_.slice(1) : arguments_;
const roots = (requested.length === 0 ? ['.'] : requested).map(
  (root) => relative(ROOT_DIR, resolve(root)) || '.'
);
const cycles = scanImportCycles(roots, ROOT_DIR);
for (const cycle of cycles) {
  const rule = cycle.files.length === 2 ? 'import/no-self-import' : 'import/no-cycle';
  console.error(
    `${cycle.files[0]}:${cycle.line}:${cycle.column} ${rule} ${cycle.files.join(' -> ')}`
  );
}
if (json) console.log(JSON.stringify({ cycles: cycles.map((cycle) => cycle.files) }));
else console.log(`Found ${cycles.length} import cycle${cycles.length === 1 ? '' : 's'}.`);
process.exit(cycles.length ? 1 : 0);
