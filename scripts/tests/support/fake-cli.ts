import { copyFileSync, linkSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

let compiledLauncher: string | undefined;
const executableSuffix = process.platform === 'win32' ? '.exe' : '';

/**
 * Install a named Bun fixture that a subprocess can find through native PATH lookup.
 * @example installFakeCli(directory, 'gh', 'console.log(JSON.stringify({ id: 42 }));');
 */
export function installFakeCli(directory: string, name: string, source: string): void {
  if (process.platform === 'win32') {
    installCompiledFakeCli(directory, name, source);
    return;
  }
  const script = source.startsWith('#!') ? source : `#!/usr/bin/env bun\n${source}`;
  writeFileSync(join(directory, name), script, { mode: 0o755 });
}

/**
 * Install the compiled fixture launcher and the script it runs.
 * @example installCompiledFakeCli(directory, 'gh', 'console.log("fixture");');
 */
export function installCompiledFakeCli(directory: string, name: string, source: string): void {
  const executable = join(directory, `${name}${executableSuffix}`);
  const launcher = (compiledLauncher ??= compileLauncher());
  writeFileSync(`${executable}.ts`, source);
  try {
    linkSync(launcher, executable);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    copyFileSync(launcher, executable);
  }
}

/**
 * Put the fixture directory first in the child's single native PATH value.
 * @example Bun.spawnSync(['bun', entrypoint], { env: fakeCliEnvironment(directory) });
 */
export function fakeCliEnvironment(
  directory: string,
  ambient: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const environment = { ...ambient };
  const inherited =
    ambient.PATH ?? Object.entries(ambient).find(([key]) => key.toLowerCase() === 'path')?.[1];
  for (const key of Object.keys(environment)) {
    if (key.toLowerCase() === 'path') delete environment[key];
  }
  environment.PATH = inherited ? `${directory}${delimiter}${inherited}` : directory;
  return environment;
}

/**
 * Remove the launcher's private cache after the Bun worker finishes its suite.
 * @example afterAll(disposeCompiledFakeCli);
 */
export function disposeCompiledFakeCli(): void {
  if (!compiledLauncher) return;
  rmSync(dirname(compiledLauncher), { recursive: true, force: true });
  compiledLauncher = undefined;
}

function compileLauncher(): string {
  const directory = mkdtempSync(join(tmpdir(), 'mango-fake-cli-'));
  const entrypoint = join(directory, 'launcher.ts');
  const executable = join(directory, `launcher${executableSuffix}`);
  try {
    writeFileSync(
      entrypoint,
      `const result = Bun.spawnSync([${JSON.stringify(process.execPath)}, process.execPath + '.ts', ...process.argv.slice(2)], {
        stdin: 'inherit', stdout: 'inherit', stderr: 'inherit',
      });
      process.exit(result.exitCode ?? 1);
      `
    );
    const result = Bun.spawnSync([
      process.execPath,
      'build',
      '--compile',
      '--no-compile-autoload-dotenv',
      '--no-compile-autoload-bunfig',
      entrypoint,
      '--outfile',
      executable,
    ]);
    if (result.exitCode !== 0) {
      throw new Error(
        `Expected native CLI fixture compilation exit 0 | received: ${result.exitCode} ${result.stderr.toString()}`
      );
    }
    return executable;
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
