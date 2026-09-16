/** `bun run fix`: apply Biome fixes, dprint formatting and rustfmt. */

import { exitWith, hasCargo, runSequential, task, warnNoCargo } from './lib';

const tasks = [
  task('biome --write', ['bunx', 'biome', 'check', '--write', '.']),
  task('dprint fmt', ['bunx', 'dprint', 'fmt']),
];
if (hasCargo()) {
  tasks.push(task('cargo fmt', ['cargo', 'fmt', '--all']));
} else {
  warnNoCargo();
}

exitWith(await runSequential(tasks));
