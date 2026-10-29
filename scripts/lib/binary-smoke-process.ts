import { delimiter, resolve } from 'node:path';

import { hostReleasePlatform } from './bun-cross-runtime';
import { pickPlatformBudgetMs } from './platform-budget';
import type { ReleasePlatformId } from './release-targets';

/** Process operations owned by one smoke invocation, replaceable by named fakes. */
export interface SmokeProcessControl {
  readonly exited: Promise<number>;
  readonly exitCode: number | null;
  /** Includes descendants, even after the hub exits. */
  alive(): Promise<boolean>;
  signal(signal: 'SIGTERM' | 'SIGKILL'): Promise<void>;
}

/**
 * Stop the owned hub and descendants within explicit deadlines; forced cleanup is a failure.
 * @example await stopSmokeProcess(control);
 */
export async function stopSmokeProcess(
  control: SmokeProcessControl,
  options: {
    graceMs?: number;
    killMs?: number;
    platform?: NodeJS.Platform;
    requireExitZero?: boolean;
  } = {}
): Promise<void> {
  const graceMs = options.graceMs ?? pickPlatformBudgetMs(15_000, 30_000);
  const killMs = options.killMs ?? 5_000;
  let exited = false;
  void control.exited.then(() => {
    exited = true;
  });
  const errors: string[] = [];
  const settled = async (budgetMs: number): Promise<boolean> => {
    const deadline = performance.now() + budgetMs;
    do {
      if (exited) {
        try {
          if (!(await control.alive())) return true;
        } catch (error) {
          errors.push(String(error));
          return false;
        }
      }
      await Bun.sleep(10);
    } while (performance.now() < deadline);
    return false;
  };
  let graceful = false;
  try {
    await control.signal('SIGTERM');
    graceful = await settled(graceMs);
  } catch (error) {
    errors.push(String(error));
  }
  if (!graceful) {
    try {
      await control.signal('SIGKILL');
    } catch (error) {
      errors.push(String(error));
    }
    const gone = await settled(killMs);
    throw new Error(
      `hub shutdown: expected owned processes gone within ${graceMs}ms without forced cleanup | received SIGKILL, settled=${gone}${errors.length ? `; ${errors.join('; ')}` : ''}`
    );
  }
  if (
    options.requireExitZero !== false &&
    (options.platform ?? process.platform) !== 'win32' &&
    control.exitCode !== 0
  ) {
    throw new Error(`hub shutdown: expected graceful exit 0 | received ${control.exitCode}`);
  }
}

/**
 * Isolate the artifact from developer config and runtime overrides while retaining OS launch paths.
 * @example const env = artifactSmokeEnvironment(process.env, home, checkout);
 */
export function artifactSmokeEnvironment(
  source: NodeJS.ProcessEnv,
  home: string,
  checkout: string
): Record<string, string> {
  const env: Record<string, string> = {};
  const osKeys = [
    'SystemRoot',
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    'PATHEXT',
    'LANG',
    'LC_ALL',
    'TZ',
    'TMP',
    'TEMP',
    'TMPDIR',
  ];
  for (const key of osKeys) if (source[key] !== undefined) env[key] = source[key];
  const root = resolve(checkout);
  env.PATH = (source.PATH ?? '')
    .split(delimiter)
    .filter(
      (entry) =>
        entry &&
        !resolve(entry).startsWith(root) &&
        !entry.replaceAll('\\', '/').includes('/node_modules/')
    )
    .join(delimiter);
  return {
    ...env,
    NODE_ENV: 'production',
    HOME: home,
    USERPROFILE: home,
    MANGO_HOME: home,
    XDG_CONFIG_HOME: resolve(home, 'config'),
    XDG_DATA_HOME: resolve(home, 'data'),
    XDG_CACHE_HOME: resolve(home, 'cache'),
    APPDATA: resolve(home, 'config'),
    LOCALAPPDATA: resolve(home, 'data'),
    MANGO_UPDATES_CHECK: '0',
    MANGO_ENV_LTS_REFRESH: '0',
    MANGO_ENV_INSTALLS_ENABLED: '0',
  };
}

/** Run only a matching native platform, including its libc. @example canExecuteArtifact('linux-x64-musl'); */
export function canExecuteArtifact(
  target: ReleasePlatformId,
  host = hostReleasePlatform()
): boolean {
  return target === host;
}

/** Await owned work within a deadline, naming the unsettled operation. @example await awaitSmokeCompletion(child.exited, 1000, 'runtime exit'); */
export async function awaitSmokeCompletion<T>(
  work: Promise<T>,
  budgetMs: number,
  label: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label}: expected settlement within ${budgetMs}ms`)),
          budgetMs
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
