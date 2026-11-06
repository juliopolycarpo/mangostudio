import { copyFileSync, linkSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

let windowsLauncher: string | undefined;

/**
 * Install a named Bun fixture that a subprocess can find through native PATH lookup.
 * @example installFakeCli(directory, 'gh', 'console.log(JSON.stringify({ id: 42 }));');
 */
export function installFakeCli(directory: string, name: string, source: string): void {
  const path = join(directory, name);
  if (process.platform !== 'win32') {
    const script = source.startsWith('#!') ? source : `#!/usr/bin/env bun\n${source}`;
    writeFileSync(path, script, { mode: 0o755 });
    return;
  }

  const executable = `${path}.exe`;
  const launcher = (windowsLauncher ??= compileWindowsLauncher());
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

function compileWindowsLauncher(): string {
  const directory = mkdtempSync(join(tmpdir(), 'mango-fake-cli-'));
  const entrypoint = join(directory, 'launcher.ts');
  const executable = join(directory, 'launcher.exe');
  writeFileSync(
    entrypoint,
    `const result = Bun.spawnSync([${JSON.stringify(process.execPath)}, process.execPath + '.ts', ...process.argv.slice(2)], {
      stdin: 'inherit', stdout: 'inherit', stderr: 'inherit',
    });
    process.exit(result.exitCode);
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
    rmSync(directory, { recursive: true, force: true });
    throw new Error(
      `Expected native CLI fixture compilation exit 0 | received: ${result.exitCode} ${result.stderr.toString()}`
    );
  }
  process.once('exit', () => rmSync(directory, { recursive: true, force: true }));
  return executable;
}
