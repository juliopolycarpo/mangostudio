// A guardian for the children a script runner owns, so that SIGKILL (or an OOM
// kill) of the runner does not leave them running.
//
// SIGINT, SIGTERM and SIGHUP are handled by ./process-tree, which forwards them
// to every child group. SIGKILL cannot be caught, so a runner that dies of it
// forwards nothing. The guardian is a second process that outlives the runner:
//
//   - The runner starts it lazily, before the first child it will own, and keeps
//     the write end of one pipe to the guardian's stdin. Nothing else holds that
//     end (Bun marks it close-on-exec and the guardian has the read end only), so
//     EOF on it means the runner is gone, whatever the cause.
//   - The runner writes one line when it starts owning a child and one when that
//     child has exited: `group <pid>` or `pid <pid>`, then `done <pid>`.
//   - On EOF the guardian SIGTERMs whatever is still registered, waits the same
//     grace the runner gives a cancelled child, SIGKILLs what is left and exits.
//     On a normal runner exit every child is already deregistered, so EOF finds
//     nothing to do and the guardian ends at once.
//   - A runner that has itself signalled its children (it was cancelled, it is
//     exiting with children live, it escalated to SIGKILL) writes `stopping`,
//     synchronously, in the same breath. Children registered by then count as
//     signalled: on EOF the guardian does not SIGTERM them a second time, which a
//     tool that reads a repeated SIGTERM as "force quit" would take for one. It
//     still waits the grace and SIGKILLs what is left. A runner killed by SIGKILL
//     writes nothing, so its children still get SIGTERM, grace, SIGKILL.
//
// The guardian leads a session of its own (so a terminal hangup or a group signal
// aimed at the runner never reaches it), has its stdio detached, and ignores
// SIGINT, SIGTERM and SIGHUP. It is a Bun process, as this repository's scripts
// already are; the runner never waits for it to start, and bytes written before
// it reads them wait in the pipe, so a runner killed a moment after it spawned a
// child is still covered.
//
// What the guardian signals depends on how the runner supervised the child:
//
//   - `group`: the child leads its own process group, so the whole group is
//     signalled, grandchildren included.
//   - `pid`: an interactive child (stdin inherited) shares the terminal's
//     foreground group with the runner, the shell and anything else in the job.
//     Signalling that group would hit unrelated processes, so only the child's
//     own pid is signalled and its descendants are not covered.
//
// Windows has the job object in ./process-tree and never starts a guardian.
//
// Pid reuse. Only registered entries are signalled, and an entry is deregistered
// as soon as the runner has reaped the child, a few event-loop turns after the
// exit. While the leader is unreaped (a zombie) its pid cannot be reused, and
// while any member of its group lives the group id cannot be either. Two windows
// remain, each needing an unrelated process to be created with exactly that id
// (the pid space has to wrap, 32768 to 4 million ids deep):
//   - between the kernel freeing the id and the `done` line arriving, with the
//     runner killed in the same instant;
//   - once the runner is gone, from the moment the guardian sees a child gone to
//     its next probe. It never probes or signals that child again, so this is one
//     poll interval (25 ms), not the grace.
// That is why this does not carry a per-process identity token like the Rust
// runtime's guardian does. The span between spawning a child and registering it
// is the other gap: a runner killed inside it loses that one child.
//
// Run directly, as `bun runner-guardian.ts <runner pid> <grace ms>`, this file is
// the guardian program; the runner pid is only there to name the process in `ps`.

/** What a registered pid names: a process group the child leads, or the child alone. */
type GuardedKind = 'group' | 'pid';

/** One child the runner has asked the guardian to stop if the runner dies. */
export interface GuardedChild {
  readonly kind: GuardedKind;
  readonly pid: number;
}

/** One decoded line of the registration protocol. */
export type GuardianCommand =
  | { readonly op: 'watch'; readonly child: GuardedChild }
  | { readonly op: 'done'; readonly pid: number }
  | { readonly op: 'stopping' };

/** Bun's orphan policy rides into children in this variable; see {@link launchGuardian}. */
const BUN_ORPHAN_POLICY_ENV = 'BUN_FEATURE_FLAG_NO_ORPHANS';

/** The line the guardian program prints on stdout once it ignores the cancelling signals. */
export const GUARDIAN_READY = 'guardian ready';

/** How often the guardian looks for registered children that are still running. */
const POLL_MS = 25;

/**
 * The line that registers a child with the guardian.
 *
 * @example
 * encodeWatch({ kind: 'group', pid: 4242 }); // 'group 4242\n'
 */
export function encodeWatch(child: GuardedChild): string {
  return `${child.kind} ${child.pid}\n`;
}

/**
 * The line that deregisters a child that has exited.
 *
 * @example
 * encodeDone(4242); // 'done 4242\n'
 */
export function encodeDone(pid: number): string {
  return `done ${pid}\n`;
}

/**
 * The line that says the runner has already signalled every child registered so far.
 *
 * @example
 * encodeStopping(); // 'stopping\n'
 */
export function encodeStopping(): string {
  return 'stopping\n';
}

/**
 * Decodes one protocol line, or `undefined` when it is not one. Pids below 2 are
 * refused: `kill(-1)` reaches every process the user owns and pid 0 is the
 * caller's own group, so neither can ever be a child a runner registered.
 *
 * @example
 * parseCommand('pid 4242'); // { op: 'watch', child: { kind: 'pid', pid: 4242 } }
 */
export function parseCommand(line: string): GuardianCommand | undefined {
  if (line === 'stopping') return { op: 'stopping' };
  const match = /^(group|pid|done) (\d{1,10})$/.exec(line);
  if (!match) return undefined;

  const pid = Number(match[2]);
  if (!Number.isSafeInteger(pid) || pid < 2) return undefined;
  return match[1] === 'done'
    ? { op: 'done', pid }
    : { op: 'watch', child: { kind: match[1] as GuardedKind, pid } };
}

/**
 * Splits a byte stream into complete lines. A trailing fragment without its
 * newline is held back and never returned: a registration is written in one
 * `write` far below the pipe's atomic size, so a fragment is a runner that died
 * mid-write and describes nothing.
 *
 * @example
 * const lines = new LineBuffer();
 * lines.push('group 4'); // []
 * lines.push('242\ndone 4242\n'); // ['group 4242', 'done 4242']
 */
export class LineBuffer {
  private held = '';

  push(text: string): string[] {
    const parts = (this.held + text).split('\n');
    this.held = parts.pop() ?? '';
    return parts;
  }
}

/**
 * The children registered right now, and which of them the runner has already
 * signalled. A pid registers once and leaves on `done`; a repeat `watch` for the
 * same pid replaces the entry (unsignalled) rather than doubling it, so one child
 * is never signalled twice. `stopping` marks the children registered at that
 * moment, not ones that register after it.
 *
 * @example
 * const ledger = new GuardianLedger();
 * ledger.apply('group 4242');
 * ledger.entries(); // [{ kind: 'group', pid: 4242 }]
 */
export class GuardianLedger {
  private readonly children = new Map<number, { child: GuardedChild; signalled: boolean }>();

  /** Applies one line; a line that is not a command changes nothing. */
  apply(line: string): void {
    const command = parseCommand(line);
    if (!command) return;
    if (command.op === 'done') {
      this.children.delete(command.pid);
    } else if (command.op === 'stopping') {
      for (const entry of this.children.values()) entry.signalled = true;
    } else {
      this.children.set(command.child.pid, { child: command.child, signalled: false });
    }
  }

  entries(): GuardedChild[] {
    return [...this.children.values()].map((entry) => entry.child);
  }

  /** The pids of the registered children the runner has already signalled. */
  signalled(): Set<number> {
    const pids = new Set<number>();
    for (const [pid, entry] of this.children) if (entry.signalled) pids.add(pid);
    return pids;
  }
}

/** What the guardian needs from the machine, so a test can fake it. */
export interface GuardianHost {
  /** Sends `signal` to the child; one that has vanished is not an error. */
  signal(child: GuardedChild, signal: NodeJS.Signals): void;
  /** True while the child, or for a group any member of it, is still there. */
  alive(child: GuardedChild): boolean;
  sleep(ms: number): Promise<void>;
  now(): number;
}

/** The host that is the running process. */
function processGuardianHost(): GuardianHost {
  return {
    signal(child, signal) {
      try {
        process.kill(child.kind === 'group' ? -child.pid : child.pid, signal);
      } catch {
        // Already gone between the decision and the call.
      }
    },
    alive(child) {
      try {
        process.kill(child.kind === 'group' ? -child.pid : child.pid, 0);
        return true;
      } catch (caught) {
        // EPERM means it exists but is not ours to signal; only ESRCH is gone.
        return (caught as NodeJS.ErrnoException).code !== 'ESRCH';
      }
    },
    sleep: (ms) => Bun.sleep(ms),
    now: () => Date.now(),
  };
}

/**
 * The runner is gone: SIGTERM every registered child the runner has not already
 * signalled, give them `graceMs` to leave, SIGKILL the ones still running.
 * Returns the children it had to SIGKILL.
 *
 * A child seen gone is dropped for good and never probed or signalled again: its
 * pid or group id is free to be reused by an unrelated process from that moment,
 * so a later probe could hit a stranger. Every SIGKILL goes to a child seen
 * running in the same poll that decided it.
 *
 * @example
 * const killed = await stopRegistered(ledger.entries(), host, 5_000, ledger.signalled());
 */
export async function stopRegistered(
  children: readonly GuardedChild[],
  host: GuardianHost,
  graceMs: number,
  alreadySignalled: ReadonlySet<number> = new Set()
): Promise<GuardedChild[]> {
  for (const child of children) {
    if (!alreadySignalled.has(child.pid)) host.signal(child, 'SIGTERM');
  }

  const deadline = host.now() + graceMs;
  let running = [...children];
  for (;;) {
    running = running.filter((child) => host.alive(child));
    if (running.length === 0 || host.now() >= deadline) break;
    await host.sleep(POLL_MS);
  }

  for (const child of running) host.signal(child, 'SIGKILL');
  return running;
}

/**
 * The guardian's whole life: read registrations until the runner's end of the
 * pipe closes, then stop whatever is still registered.
 *
 * @example
 * await runGuardian(Bun.stdin.stream(), host, 5_000);
 */
export async function runGuardian(
  input: AsyncIterable<Uint8Array>,
  host: GuardianHost,
  graceMs: number
): Promise<GuardedChild[]> {
  const ledger = new GuardianLedger();
  const lines = new LineBuffer();
  const decoder = new TextDecoder();
  for await (const chunk of input) {
    for (const line of lines.push(decoder.decode(chunk, { stream: true }))) ledger.apply(line);
  }
  return stopRegistered(ledger.entries(), host, graceMs, ledger.signalled());
}

/** The ways a runner writes to its guardian; a test supplies a recording fake. */
export interface GuardianChannel {
  /** Delivers one protocol line to the guardian. */
  send(line: string): void;
}

/**
 * The runner's side of the guardian: starts it on first use and registers
 * children with it. It fails open. A build must not fail because a safety net
 * could not be hung, and the net only matters when the runner is killed, so a
 * guardian that cannot start, or stops answering, is reported once on stderr and
 * the run carries on without it.
 *
 * @example
 * const guardian = new GuardianLink(() => launchGuardian(5_000), console.error);
 * guardian.open();
 * const release = guardian.watch({ kind: 'group', pid: child.pid });
 * await child.exited;
 * release();
 */
export class GuardianLink {
  private channel: GuardianChannel | undefined;
  private failed = false;

  constructor(
    private readonly launch: () => GuardianChannel,
    private readonly report: (message: string) => void
  ) {}

  /** True once a guardian is running and has not failed. */
  get active(): boolean {
    return this.channel !== undefined && !this.failed;
  }

  /** Starts the guardian if it is not running yet. Call before spawning the child it will cover. */
  open(): void {
    if (this.channel || this.failed) return;
    try {
      this.channel = this.launch();
    } catch (caught) {
      this.fail('could not start', caught);
    }
  }

  /**
   * Says that the runner has just signalled every child it registered, so the
   * guardian must not signal them again. Synchronous like every write here, so a
   * runner in its `exit` handler can use it, and never throws.
   */
  stopping(): void {
    this.send(encodeStopping());
  }

  /** Registers `child`; the result deregisters it and must run once the child was reaped. */
  watch(child: GuardedChild): () => void {
    this.open();
    this.send(encodeWatch(child));

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.send(encodeDone(child.pid));
    };
  }

  private send(line: string): void {
    if (!this.channel || this.failed) return;
    try {
      this.channel.send(line);
    } catch (caught) {
      this.fail('stopped answering', caught);
    }
  }

  private fail(what: string, caught: unknown): void {
    this.failed = true;
    const reason = caught instanceof Error ? caught.message : String(caught);
    try {
      this.report(
        `runner: the guardian ${what} (${reason}); if this runner is killed, its commands may keep running`
      );
    } catch {
      // A hung-up terminal has nowhere to print to, and this may run while exiting.
    }
  }
}

/**
 * Starts the guardian as a process of its own and returns the runner's end of
 * its pipe. `detached` makes it a session leader. Its stdio is detached: a
 * guardian holding the runner's stdout open would stall `bun run x | tee` until
 * it ended. The orphan policy is switched off for it: a Bun started with
 * `--no-orphans` ends when its parent does, which is exactly when the guardian
 * has work to do.
 *
 * @example
 * const channel = launchGuardian(5_000);
 * channel.send('group 4242\n');
 */
export function launchGuardian(graceMs: number): GuardianChannel {
  const guardian = Bun.spawn(
    [process.execPath, import.meta.path, String(process.pid), String(graceMs)],
    {
      cwd: '/',
      stdin: 'pipe',
      stdout: 'ignore',
      stderr: 'ignore',
      env: { ...process.env, [BUN_ORPHAN_POLICY_ENV]: '0' },
      detached: true,
    }
  );
  // The runner must be able to exit without waiting for it.
  guardian.unref();
  return {
    send(line) {
      // A sink whose pipe has closed answers `true` where an open one answers
      // with the byte count: the guardian is gone, and the link reports it.
      const accepted = guardian.stdin.write(line);
      if (typeof accepted !== 'number') throw new Error('its pipe is closed');
      // Written now, not queued: a runner killed next instant must still have said it.
      void guardian.stdin.flush();
    },
  };
}

/** Program entry: `bun runner-guardian.ts <runner pid> <grace ms>`. */
async function main(args: readonly string[]): Promise<void> {
  const graceMs = Number(args[1]);
  if (!Number.isInteger(graceMs) || graceMs < 0) {
    throw new Error(`(runner guardian): expected grace in ms | received: ${String(args[1])}`);
  }
  // The runner's own cancellation signals must not reach this process; it is the
  // one that has to still be here when the runner is not.
  for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(name, () => undefined);
  }
  // Tells whoever reads stdout (the runner points it at /dev/null) that the
  // handlers above exist, so a test can signal the guardian without racing startup.
  await Bun.write(Bun.stdout, `${GUARDIAN_READY}\n`);
  await runGuardian(Bun.stdin.stream(), processGuardianHost(), graceMs);
  process.exit(0);
}

if (import.meta.main) await main(process.argv.slice(2));
