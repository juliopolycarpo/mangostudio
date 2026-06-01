import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runAutoFixHook } from '../../.codex/hooks/auto-fix.mjs';

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  await runAutoFixHook();
}
