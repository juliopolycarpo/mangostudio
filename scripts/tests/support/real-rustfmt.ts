import { statSync } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute } from 'node:path';

interface QueryResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  signalCode?: NodeJS.Signals | number;
  exitedDueToTimeout?: boolean;
  exitedDueToMaxBuffer?: boolean;
}

interface RustfmtDiscovery {
  readonly platform: NodeJS.Platform;
  which(command: string): string | null;
  query(command: string[], env: NodeJS.ProcessEnv): QueryResult;
  isFile(path: string): boolean;
}

interface RustfmtSelection {
  readonly path?: string;
  readonly source: 'rustup' | 'path';
  readonly command: readonly string[];
  readonly exitCode?: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly unavailable?: string;
}

const nativeDiscovery: RustfmtDiscovery = {
  platform: process.platform,
  which: (command) => Bun.which(command),
  query(command, env) {
    const result = Bun.spawnSync(command, { env, stdout: 'pipe', stderr: 'pipe', timeout: 5000 });
    return {
      exitCode: result.exitCode,
      signalCode: result.signalCode,
      exitedDueToTimeout: result.exitedDueToTimeout,
      exitedDueToMaxBuffer: result.exitedDueToMaxBuffer,
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

function boundedDiagnostic(value: string): string {
  const limit = 2048;
  return value.length <= limit
    ? value
    : `${value.slice(0, limit)}...[truncated, ${value.length} characters]`;
}

function describeQuery(command: string[], result: QueryResult): string {
  return JSON.stringify({
    command: command.map(boundedDiagnostic),
    exitCode: result.exitCode,
    signalCode: result.signalCode,
    exitedDueToTimeout: result.exitedDueToTimeout,
    exitedDueToMaxBuffer: result.exitedDueToMaxBuffer,
    stdout: boundedDiagnostic(result.stdout),
    stderr: boundedDiagnostic(result.stderr),
  });
}

function requireNonInstallingRustup(
  discovery: RustfmtDiscovery,
  rustup: string,
  env: NodeJS.ProcessEnv
): void {
  // Unlike --version, --help does not resolve or install the active toolchain.
  const command = [rustup, '--help'];
  let result = discovery.query(command, env);
  if (
    discovery.platform === 'win32' &&
    result.exitCode === null &&
    result.exitedDueToTimeout &&
    !result.exitedDueToMaxBuffer
  ) {
    console.warn(
      `real rustfmt discovery: retrying timed-out rustup help once | received: ${describeQuery(command, result)}`
    );
    result = discovery.query(command, env);
  }
  const line = result.stdout.split(/\r?\n/, 1)[0];
  const version = /^rustup (\d+)\.(\d+)\.(\d+)(?: \([^\r\n]*\))?$/.exec(line);
  const parts = version?.slice(1).map(Number);
  if (
    result.exitCode === 0 &&
    !result.signalCode &&
    !result.exitedDueToTimeout &&
    !result.exitedDueToMaxBuffer &&
    parts?.every(Number.isSafeInteger)
  ) {
    const [major, minor, patch] = parts;
    if (major > 1 || (major === 1 && (minor > 28 || (minor === 28 && patch >= 1)))) return;
  }
  throw new Error(
    `real rustfmt discovery: expected ${result.exitCode === 0 && !result.signalCode && !result.exitedDueToTimeout && !result.exitedDueToMaxBuffer ? 'rustup 1.28.1 or newer with non-installing lookup' : 'successful rustup help query'} | received: ${describeQuery(command, result)}`
  );
}

/**
 * Resolve the installed formatter itself rather than the ambient rustup proxy.
 * Require rustup 1.28.1 or newer so toolchain installation can be explicitly
 * disabled; older managers are rejected before looking up the formatter.
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
  const env = { ...process.env, RUSTUP_AUTO_INSTALL: '0' };
  requireNonInstallingRustup(discovery, rustup, env);
  const result = discovery.query(command, env);
  const selection = { source: 'rustup' as const, command, ...result };
  if (
    result.exitCode !== 0 ||
    result.signalCode ||
    result.exitedDueToTimeout ||
    result.exitedDueToMaxBuffer
  ) {
    // Rustup identifies a missing component explicitly. Any other failure,
    // including a timeout or malformed output, must not hide this test.
    const missingComponent =
      /^error: 'rustfmt(?:\.exe)?' is not installed for the toolchain '[^'\r\n]+'\.(?:\r?\nhelp: [^\r\n]+)*(?:\r?\n)?$/.test(
        result.stderr
      );
    const missingToolchain =
      /^error: toolchain '[^'\r\n]+' is not installed(?:\r?\nhelp: [^\r\n]+)*(?:\r?\n)?$/.test(
        result.stderr
      );
    if (
      result.exitCode === 1 &&
      !result.signalCode &&
      !result.exitedDueToTimeout &&
      !result.exitedDueToMaxBuffer &&
      result.stdout === ''
    ) {
      if (missingComponent)
        return { ...selection, unavailable: 'the pinned rustfmt component is unavailable' };
      if (missingToolchain)
        return { ...selection, unavailable: 'the pinned Rust toolchain is unavailable' };
    }
    throw new Error(
      `real rustfmt discovery: expected a successful rustfmt lookup or confirmed missing component or toolchain | received: ${describeQuery(command, result)}`
    );
  }
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
