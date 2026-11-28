import type { GhCommandResult, GhCommandRunner } from '../../lib/canary-github';

/** Answers a `gh` call the script did not name, or returns undefined for "not served". */
export type GhFallback = (args: readonly string[]) => GhCommandResult | undefined;

/**
 * A named fake of the `gh` CLI. Each exact argument list can be scripted with
 * results consumed in order (`script`) or with one result forever (`always`);
 * anything else goes to the optional fallback, and an unserved call fails
 * naming its arguments. It records every call.
 * @example runner.script(['api', path], ghFailure('gh: Bad Gateway (HTTP 502)'), ghJson({ id: 1 }));
 */
export class ScriptedGhRunner implements GhCommandRunner {
  readonly calls: string[][] = [];
  private readonly queues = new Map<string, GhCommandResult[]>();
  private readonly persistent = new Map<string, GhCommandResult>();

  constructor(private readonly fallback?: GhFallback) {}

  /** Queue results for one exact argument list; they answer its next calls in order. */
  script(args: readonly string[], ...results: GhCommandResult[]): this {
    this.queues.set(JSON.stringify(args), [...results]);
    return this;
  }

  /** Answer every call of one exact argument list with the same result. */
  always(args: readonly string[], result: GhCommandResult): this {
    this.persistent.set(JSON.stringify(args), result);
    return this;
  }

  /** Calls made with exactly these arguments. */
  callsOf(args: readonly string[]): number {
    const key = JSON.stringify(args);
    return this.calls.filter((call) => JSON.stringify(call) === key).length;
  }

  run(args: readonly string[]): GhCommandResult {
    this.calls.push([...args]);
    const key = JSON.stringify(args);
    const queued = this.queues.get(key)?.shift();
    if (queued) return queued;
    const always = this.persistent.get(key);
    if (always) return always;
    const served = this.fallback?.(args);
    if (served) return served;
    throw new Error(`Unexpected fake gh call: ${JSON.stringify(args)}`);
  }
}

/** A failed `gh` call with the stderr gh prints, e.g. `gh: Bad Gateway (HTTP 502)`. */
export function ghFailure(stderr: string, exitCode = 1): GhCommandResult {
  return { exitCode, stdout: Buffer.alloc(0), stderr };
}

/** A successful plain `gh api <path>` call. */
export function ghJson(body: unknown): GhCommandResult {
  return { exitCode: 0, stdout: Buffer.from(JSON.stringify(body)), stderr: '' };
}

/** A successful `gh api --paginate --slurp` call: one page per element. */
export function ghPages(pages: readonly unknown[]): GhCommandResult {
  return ghJson(pages);
}

/** An answered `gh api --include` call: status line, one header, blank line, JSON body. */
export function ghHttp(status: number, body: unknown): GhCommandResult {
  return {
    exitCode: status >= 400 ? 1 : 0,
    stdout: Buffer.from(
      `HTTP/2.0 ${status} Status\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(body)}`
    ),
    stderr: status >= 400 ? `gh: Status (HTTP ${status})` : '',
  };
}

/**
 * Serve `gh api` reads from a map of API values, the way the CLI fakes of the
 * canary tests do: a plain call answers the value, a `--paginate --slurp` call
 * answers one page carrying `total_count` and the entries under `collectionKey`.
 * @example new ScriptedGhRunner(ghServing(values, { prefix: 'repos/owner/repo/', collectionKey: () => 'jobs' }))
 */
export function ghServing(
  values: ReadonlyMap<string, unknown>,
  options: { readonly prefix: string; readonly collectionKey: (path: string) => string }
): GhFallback {
  return (args) => {
    const path = args.at(-1);
    if (!path?.startsWith(options.prefix)) return undefined;
    const value = values.get(path.slice(options.prefix.length));
    if (value === undefined) return undefined;
    if (!args.includes('--paginate')) return ghJson(value);
    const entries = value as unknown[];
    return ghPages([{ total_count: entries.length, [options.collectionKey(path)]: entries }]);
  };
}
