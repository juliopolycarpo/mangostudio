/**
 * The one owner of local-socket addresses in the protocol tests.
 *
 * `listenIpc` preserves a public socket path on close (the transport cannot prove
 * it still owns the file), so every test that listens leaves a file behind unless
 * the test removes it. This module hands out addresses inside a per-run temporary
 * directory, removes them after every case even when the case failed, and fails
 * the suite when a socket file for this process is still lying around in the
 * directories an address could have been derived from (`ipcPath` uses
 * `$XDG_RUNTIME_DIR`, else the temp directory).
 *
 * Paths stay short: a Unix `sun_path` holds about 104 bytes, and the address is
 * `<tmpdir>/mps-XXXXXX/<n>.sock`.
 */

import { afterAll, afterEach } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WINDOWS = process.platform === 'win32';

/** Directories `ipcPath` may place a socket in, without duplicates. */
function defaultWatchedDirectories(): string[] {
  const runtime = process.env.XDG_RUNTIME_DIR;
  const directories = [tmpdir()];
  if (runtime !== undefined && runtime.length > 0) directories.push(runtime);
  return [...new Set(directories)];
}

/**
 * The socket files named for `pid` (`mango-<suite>-<pid>-<n>.sock`) in each
 * directory. Scoped to one pid so a parallel run's files are never blamed.
 * A named pipe has no file, so Windows has nothing to list.
 *
 * @example
 * leftoverSocketFiles(['/run/user/1000'], 4242); // ['/run/user/1000/mango-protocol-test-4242-3.sock']
 */
export function leftoverSocketFiles(directories: readonly string[], pid: number): string[] {
  if (WINDOWS) return [];
  const own = new RegExp(`^mango-.+-${pid}-\\d+\\.sock$`);
  const found: string[] = [];
  for (const directory of directories) {
    let names: string[];
    try {
      names = readdirSync(directory);
    } catch {
      continue;
    }
    for (const name of names) if (own.test(name)) found.push(join(directory, name));
  }
  return found.sort();
}

export interface SocketTestHomeOptions {
  /** Where leftover files are looked for. Defaults to the directories `ipcPath` uses. */
  readonly watchedDirectories?: readonly string[];
  /** The pid whose files are counted. Defaults to this process. */
  readonly pid?: number;
}

/** Hands out socket addresses and takes them back. */
export class SocketTestHome {
  readonly #watched: readonly string[];
  readonly #pid: number;
  readonly #label: string;
  readonly #issued = new Set<string>();
  readonly #before: ReadonlySet<string>;
  #directory: string | undefined;
  #sequence = 0;

  constructor(label: string, options: SocketTestHomeOptions = {}) {
    this.#label = label;
    this.#watched = options.watchedDirectories ?? defaultWatchedDirectories();
    this.#pid = options.pid ?? process.pid;
    this.#before = new Set(leftoverSocketFiles(this.#watched, this.#pid));
  }

  /** A fresh address no other case in this run uses. Nothing exists at it yet. */
  nextAddress(): string {
    this.#sequence += 1;
    const address = WINDOWS
      ? `\\\\.\\pipe\\mango-${this.#label}-${this.#pid}-${this.#sequence}`
      : join(this.#ensureDirectory(), `${this.#sequence}.sock`);
    this.#issued.add(address);
    return address;
  }

  /** Removes every file issued so far. Run after each case, pass or fail. */
  release(): void {
    if (WINDOWS) {
      this.#issued.clear();
      return;
    }
    for (const address of this.#issued) rmSync(address, { force: true });
    this.#issued.clear();
  }

  /**
   * Removes the run directory, then throws when a socket file for this pid is
   * left in a watched directory or in the run directory. Run once after the
   * last case.
   */
  verifyNoLeftovers(): void {
    const directory = this.#directory;
    const strayInRunDirectory =
      directory === undefined ? [] : readdirSync(directory).map((name) => join(directory, name));
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
    this.#directory = undefined;
    const leaked = [
      ...strayInRunDirectory,
      ...leftoverSocketFiles(this.#watched, this.#pid).filter((path) => !this.#before.has(path)),
    ];
    if (leaked.length > 0) {
      throw new Error(
        `(${this.#label} socket tests): expected no socket files left behind | received ${leaked.length}: ${leaked.join(', ')}`
      );
    }
  }

  #ensureDirectory(): string {
    if (this.#directory === undefined) {
      this.#directory = mkdtempSync(join(tmpdir(), 'mps-'));
      // A crashed or aborted run never reaches `afterAll`; the exit hook still runs.
      const directory = this.#directory;
      process.once('exit', () => rmSync(directory, { recursive: true, force: true }));
    }
    return this.#directory;
  }
}

/**
 * A `SocketTestHome` wired to the calling test file: addresses are removed after
 * every case and the leftover check runs after the last one.
 *
 * @example
 * const sockets = useSocketTestHome('protocol-test');
 * const path = sockets.nextAddress();
 */
export function useSocketTestHome(label: string): SocketTestHome {
  const home = new SocketTestHome(label);
  afterEach(() => home.release());
  afterAll(() => home.verifyNoLeftovers());
  return home;
}
