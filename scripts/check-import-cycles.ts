import { relative, resolve } from 'node:path';
import { ROOT_DIR } from './lib/config';
import { createImportCycleCommand } from './lib/import-cycles';

const arguments_ = process.argv.slice(2);
const roots = (arguments_.length === 0 ? ['.'] : arguments_).map(
  (root) => relative(ROOT_DIR, resolve(root)) || '.'
);
const child = Bun.spawn(createImportCycleCommand(roots), {
  cwd: ROOT_DIR,
  stdout: 'inherit',
  stderr: 'inherit',
});
process.exit(await child.exited);
