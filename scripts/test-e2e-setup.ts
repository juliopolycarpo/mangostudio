import { BROWSER_SMOKE_SETUP_COMMAND } from './lib/browser-smoke';
import { ROOT_DIR } from './lib/config';
import { exitWithResults, header, runCommand } from './lib/runner';

header('Browser Smoke Setup');

const result = await runCommand('playwright:chromium', [...BROWSER_SMOKE_SETUP_COMMAND], {
  cwd: ROOT_DIR,
});

exitWithResults([result]);
