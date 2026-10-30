import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { realpathSync } from 'node:fs';

type RunAliasQuery = (path: string, timeoutMs: number) => SpawnSyncReturns<Buffer>;

const runAliasQuery: RunAliasQuery = (path, timeoutMs) =>
  spawnSync(
    'cmd.exe',
    ['/d', '/v:off', '/u', '/c', 'for %I in ("%MANGO_ALIAS_PATH%") do @echo %~sI'],
    {
      env: { ...process.env, MANGO_ALIAS_PATH: path },
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
      windowsVerbatimArguments: true,
    }
  );

/** Query a native short path for an existing entry. Example: shortPath('C:\\Program Files'). */
export function shortPath(
  path: string,
  run: RunAliasQuery = runAliasQuery,
  timeoutMs = 5_000
): string {
  if (/["\r\n]/.test(path)) {
    throw new Error(
      `expected a Windows path without quotes or newlines | received: ${JSON.stringify(path)}`
    );
  }
  const result = run(path, timeoutMs);
  const details = JSON.stringify({
    status: result.status,
    signal: result.signal,
    error: result.error?.message,
    code: (result.error as NodeJS.ErrnoException | undefined)?.code,
    stdout: result.stdout?.toString('utf16le'),
    stderr: result.stderr?.toString('utf16le'),
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0 || result.error || result.signal) {
    throw new Error(
      `expected alias query exit 0 for ${JSON.stringify(path)} | received: ${details}`
    );
  }
  const alias = result.stdout?.toString('utf16le').trim() ?? '';
  if (!alias || alias.includes('\n') || alias.includes('\r')) {
    throw new Error(`expected one Windows short path for ${path} | received: ${details}`);
  }
  return alias;
}

/** Query two paths within one five-second budget. Example: queryAliasPair(file, home). */
export function queryAliasPair(
  file: string,
  home: string,
  query: (path: string, timeoutMs: number) => string = (path, timeoutMs) =>
    shortPath(path, runAliasQuery, timeoutMs),
  now: () => number = () => performance.now()
): [string, string] {
  const deadline = now() + 5_000;
  const remaining = () => {
    const timeoutMs = Math.floor(deadline - now());
    if (timeoutMs <= 0)
      throw new Error(
        'expected Windows alias queries to finish within 5000ms | received: deadline expired'
      );
    return timeoutMs;
  };
  const binaryAlias = query(file, remaining());
  const homeAlias = query(home, remaining());
  remaining();
  return [binaryAlias, homeAlias];
}

/** Resolve real file and directory aliases if either has an 8.3 spelling. Example: windowsPathAliases(). */
function windowsPathAliases():
  { binaryPath: string; binaryAlias: string; home: string; homeAlias: string } | undefined {
  const file = Bun.which('git.exe');
  const folder = process.env.ProgramFiles;
  if (!file || !folder) {
    throw new Error(
      `expected git.exe and ProgramFiles for Windows alias fixture | received: ${JSON.stringify({ file, folder })}`
    );
  }
  const binaryPath = realpathSync.native(file);
  const home = realpathSync.native(folder);
  const [binaryAlias, homeAlias] = queryAliasPair(binaryPath, home);
  if (realpathSync.native(binaryAlias) !== binaryPath || realpathSync.native(homeAlias) !== home) {
    throw new Error(
      `expected Windows short paths to resolve to their original entries | received: ${JSON.stringify({ binaryPath, binaryAlias, home, homeAlias })}`
    );
  }
  if (!(
    (binaryAlias !== binaryPath && binaryAlias.includes('~')) ||
    (homeAlias !== home && homeAlias.includes('~'))
  ))
    return undefined;
  return { binaryPath, binaryAlias, home, homeAlias };
}

type AliasDiscovery =
  | {
      readonly kind: 'available';
      readonly paths: NonNullable<ReturnType<typeof windowsPathAliases>>;
    }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'failure'; readonly error: unknown };

/** Preserve query errors until the native test runs. Example: discoverWindowsAliases(). */
export function discoverWindowsAliases(probe = windowsPathAliases): AliasDiscovery {
  try {
    const paths = probe();
    return paths ? { kind: 'available', paths } : { kind: 'unavailable' };
  } catch (error) {
    return { kind: 'failure', error };
  }
}
