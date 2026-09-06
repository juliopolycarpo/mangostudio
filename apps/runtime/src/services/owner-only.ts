/**
 * Making one file readable by this account and nobody else.
 *
 * POSIX spells that `chmod 0600`. Windows has no mode bits to set: `chmod`
 * there sets the read-only attribute and returns success, so a runtime that
 * called it and reported "restricted" would be answering a different question
 * than the one asked. The real mechanism is an ACL, and `icacls` is how a
 * process without extra privilege writes one for a file it owns.
 *
 * The answer is a boolean rather than an exception because the caller has
 * somewhere honest to put a `false`: a warning that this machine's credentials
 * file is readable by other accounts on it.
 */

import { chmod as systemChmod } from 'node:fs/promises';
import { HIDDEN_WINDOW } from './process-window';
import { currentUserName } from './user-service-manager';

const OWNER_ONLY_MODE = 0o600;

export interface OwnerOnlyDeps {
  readonly platform: NodeJS.Platform;
  /** The account to grant. Windows only; POSIX restricts to whoever owns the file. */
  readonly user: string;
  readonly exec: (
    argv: readonly string[]
  ) => Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }>;
  readonly chmod: (path: string, mode: number) => Promise<void>;
}

/**
 * The ACL rewrite: drop every inherited entry, then grant this account alone.
 *
 * `(M)` — modify — and not `(R,W)`. Every writer here publishes through a
 * temporary file and a rename, and replacing an existing file needs DELETE on
 * it. A read/write grant would let the first write succeed and refuse every
 * rotation after it.
 * // Usage: icaclsArgv('C:\\Users\\a\\credentials.json', 'a')
 */
export function icaclsArgv(path: string, user: string): string[] {
  return ['icacls', path, '/inheritance:r', '/grant:r', `${user}:(M)`];
}

/**
 * Restricts a file to this account, reporting whether it actually happened.
 * // Usage: const restricted = await restrictToOwner(credentialsPath)
 */
export async function restrictToOwner(
  path: string,
  deps: OwnerOnlyDeps = defaultOwnerOnlyDeps()
): Promise<boolean> {
  if (deps.platform !== 'win32') {
    try {
      await deps.chmod(path, OWNER_ONLY_MODE);
      return true;
    } catch {
      return false;
    }
  }
  const result = await deps.exec(icaclsArgv(path, deps.user));
  return result.exitCode === 0;
}

export function defaultOwnerOnlyDeps(env: NodeJS.ProcessEnv = process.env): OwnerOnlyDeps {
  return {
    platform: process.platform,
    user: currentUserName(env),
    chmod: (path, mode) => systemChmod(path, mode),
    // An absent `icacls` is an unrestricted file, not a crashed `connect`.
    // `Bun.spawn` throws for a program it cannot find, and the one caller here
    // reads an exit code.
    exec: async (argv) => {
      let child: Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
      try {
        child = Bun.spawn([...argv], {
          env,
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
          timeout: 15_000,
          ...HIDDEN_WINDOW,
        });
      } catch (error) {
        return {
          exitCode: 127,
          stdout: '',
          stderr: error instanceof Error ? error.message : String(error),
        };
      }
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { exitCode, stdout, stderr };
    },
  };
}
