import { statSync } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute } from 'node:path';

interface RustfmtDiscovery {
  which(command: string): string | null;
  query(command: string[]): { exitCode: number; stdout: string; stderr: string };
  isFile(path: string): boolean;
}

interface RustfmtSelection {
  readonly path?: string;
  readonly source: 'rustup' | 'path';
  readonly command: readonly string[];
  readonly exitCode?: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly unavailable?: string;
}

const nativeDiscovery: RustfmtDiscovery = {
  which: (command) => Bun.which(command),
  query(command) {
    const result = Bun.spawnSync(command, { stdout: 'pipe', stderr: 'pipe', timeout: 5000 });
    return {
      exitCode: result.exitCode,
      stdout: new TextDecoder().decode(result.stdout),
      stderr: new TextDecoder().decode(result.stderr),
    };
  },
  isFile(path) {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  },
};

function validateFormatter(path: string, discovery: RustfmtDiscovery): string {
  const expected = 'an absolute existing rustfmt executable path';
  if (!isAbsolute(path) || !/^rustfmt(?:\.exe)?$/i.test(basename(path)) || !discovery.isFile(path))
    throw new Error(
      `real rustfmt discovery: expected ${expected} | received: ${JSON.stringify(path)}`
    );
  return path;
}

/**
 * Resolve the installed formatter itself rather than the ambient rustup proxy.
 * @example const formatter = discoverRealRustfmt();
 */
export function discoverRealRustfmt(
  discovery: RustfmtDiscovery = nativeDiscovery
): RustfmtSelection {
  const rustup = discovery.which('rustup');
  if (!rustup) {
    const path = discovery.which('rustfmt');
    return {
      source: 'path',
      command: [],
      stdout: path ?? '',
      stderr: '',
      ...(path
        ? { path: validateFormatter(path, discovery) }
        : { unavailable: 'rustfmt is not on PATH' }),
    };
  }
  const command = [rustup, 'which', 'rustfmt'];
  const result = discovery.query(command);
  const selection = { source: 'rustup' as const, command, ...result };
  if (result.exitCode !== 0)
    return { ...selection, unavailable: 'the pinned rustfmt component is unavailable' };
  return { ...selection, path: validateFormatter(result.stdout.trim(), discovery) };
}

/**
 * Select the discovered real formatter for one child without mutating its worker.
 * @example const env = realRustfmtEnvironment(formatter.path, process.env);
 */
export function realRustfmtEnvironment(
  formatter: string,
  ambient: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const environment = { ...ambient };
  const path =
    ambient.PATH ??
    Object.entries(ambient).find(([key]) => key.toLowerCase() === 'path')?.[1] ??
    '';
  for (const key of Object.keys(environment)) {
    if (key.toLowerCase() === 'path') delete environment[key];
  }
  return { ...environment, PATH: `${dirname(formatter)}${delimiter}${path}` };
}
