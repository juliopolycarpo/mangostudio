/**
 * Builds the fake `gh` of `program.ts` into a real executable and puts a copy
 * of it, with a scenario, in a directory a test can prepend to `PATH`.
 *
 * Why compiled rather than a script: see `program.ts`. `bun build --compile`
 * copies the running Bun and appends the bundle, so no toolchain beyond Bun is
 * needed and the result runs wherever the test runs.
 */

import { chmod, copyFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FAKE_GH_SCENARIO_FILE, type FakeGhScenario } from './program';

/** The file name the runtime resolves when it looks for `gh`. */
export const FAKE_GH_EXECUTABLE_NAME = process.platform === 'win32' ? 'gh.exe' : 'gh';

const PROGRAM_PATH = join(import.meta.dir, 'program.ts');

/**
 * Compiles the fake `gh` into `directory` and returns the executable's path.
 *
 * The executable is a template: it does nothing useful until
 * {@link installFakeGh} copies it next to a scenario. Build it once per test
 * file; the build writes an executable the size of Bun itself.
 *
 * Autoloading is off because the fake runs with whatever working directory the
 * runtime gives it, and a `bunfig.toml` or `.env` found there would otherwise
 * be loaded before the fake answers.
 *
 * @example
 * const built = await buildFakeGh(await mkdtemp(join(tmpdir(), 'fake-gh-build-')));
 */
export async function buildFakeGh(directory: string): Promise<string> {
  const outfile = join(directory, `fake-gh-template${process.platform === 'win32' ? '.exe' : ''}`);
  const build = Bun.spawn(
    [
      process.execPath,
      'build',
      '--compile',
      '--no-compile-autoload-dotenv',
      '--no-compile-autoload-bunfig',
      PROGRAM_PATH,
      '--outfile',
      outfile,
    ],
    { cwd: directory, stdout: 'pipe', stderr: 'pipe' }
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(build.stdout).text(),
    new Response(build.stderr).text(),
    build.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `fake gh build failed | expected: exit 0 and an executable at ${outfile} | received: exit ${exitCode}\n${stdout}${stderr}`.trim()
    );
  }
  return outfile;
}

/**
 * Copies the built fake into `directory` as `gh` (`gh.exe` on Windows), writes
 * `scenario` beside it, and returns `directory`, ready to go on `PATH`.
 *
 * @example
 * const binDir = await installFakeGh(built, { authenticated: false }, await mkdtemp(prefix));
 * process.env.PATH = `${binDir}${delimiter}${process.env.PATH}`;
 */
export async function installFakeGh(
  built: string,
  scenario: FakeGhScenario,
  directory: string
): Promise<string> {
  const target = join(directory, FAKE_GH_EXECUTABLE_NAME);
  await copyFile(built, target);
  await chmod(target, 0o755);
  await writeFile(join(directory, FAKE_GH_SCENARIO_FILE), JSON.stringify(scenario));
  return directory;
}
