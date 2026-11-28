// Diagnostics for a build-smoke script that did not reach its fake hub.
//
// `test-build-cleanup.unit.test.ts` once spent its whole 10 s spawn timeout before the fake hub
// wrote its first event (#2762), and the log could not say where the time went: the script's
// startup, its smoke setup, the hub spawn, or a hub that started and could not listen. The report
// below names the last stage the evidence proves, with timestamps, the port's current holder and
// the host load, so one more occurrence settles the cause.

/** One line of the fake hub's event log. */
export interface SmokeEvent {
  readonly event: string;
  readonly pid: number;
  readonly at?: number;
  readonly detail?: string;
}

/** The farthest point the evidence shows the smoke run reached. */
export type SmokeStage =
  | 'script-printed-nothing'
  | 'smoke-started-hub-not-spawned'
  | 'hub-spawned-never-booted'
  | 'hub-booted-bind-failed'
  | 'hub-booted-never-listened'
  | 'hub-listening';

/** What the smoke script's stdout proves, by the lines `scripts/test-build.ts` prints in order. */
const SMOKE_STARTED_LINE = 'Starting binary on port';
/** Printed by the readiness callback, which runs only after the hub spawn and its process census. */
const HUB_SPAWNED_LINE = 'Waiting for server to be ready';

/**
 * Names the last stage of the smoke run that the output and the hub's events prove.
 *
 * @example
 * classifySmokeStage('', []); // 'script-printed-nothing'
 */
export function classifySmokeStage(stdout: string, events: readonly SmokeEvent[]): SmokeStage {
  const names = new Set(events.map(({ event }) => event));
  if (names.has('startup')) return 'hub-listening';
  if (names.has('bind-failed')) return 'hub-booted-bind-failed';
  if (names.has('boot')) return 'hub-booted-never-listened';
  if (stdout.includes(HUB_SPAWNED_LINE)) return 'hub-spawned-never-booted';
  if (stdout.includes(SMOKE_STARTED_LINE)) return 'smoke-started-hub-not-spawned';
  return 'script-printed-nothing';
}

/** What each stage means for the next step of the investigation. */
const STAGE_MEANING: Record<SmokeStage, string> = {
  'script-printed-nothing':
    'the script printed nothing, so Bun never ran its first console.log: startup or the import graph stalled',
  'smoke-started-hub-not-spawned':
    'the script reached smokeTest but never printed the readiness wait: the fake ChatGPT listener, the file copies, the hub spawn or the process census stalled',
  'hub-spawned-never-booted':
    'the hub was spawned and the script waited for it, but the hub never ran its first line: the hub process start stalled',
  'hub-booted-bind-failed':
    'the hub ran and could not bind the reserved port: another process took it after the test released it',
  'hub-booted-never-listened':
    'the hub ran its first line and never reached its listener: Bun.serve stalled',
  'hub-listening': 'the hub listened',
};

/** Inputs of {@link describeSmokeStall}; every field is measured by the caller. */
export interface SmokeStallEvidence {
  readonly code: number | null;
  readonly signal: string | number | null;
  readonly elapsedMs: number;
  /** Milliseconds from spawn to the first byte of stdout or stderr; `null` when none arrived. */
  readonly firstOutputMs: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly events: readonly SmokeEvent[];
  readonly port: number;
  /** Result of {@link describePortHolder}, taken after the script was gone. */
  readonly portState: string;
  readonly load: readonly number[];
}

/**
 * The failure message for a smoke run whose hub never listened.
 *
 * @example
 * describeSmokeStall({ ...evidence, events: [] }); // '(build smoke): expected ... | received: ...'
 */
export function describeSmokeStall(evidence: SmokeStallEvidence): string {
  const stage = classifySmokeStage(evidence.stdout, evidence.events);
  const first =
    evidence.firstOutputMs === null ? 'no output' : `first output at ${evidence.firstOutputMs}ms`;
  const events =
    evidence.events.length === 0
      ? 'no events'
      : evidence.events
          .map(({ event, at, detail }) => {
            const offset = at === undefined ? '' : `@${at}`;
            return `${event}${offset}${detail ? ` (${detail})` : ''}`;
          })
          .join(', ');
  return [
    `(build smoke): expected the fake hub to record 'startup' before the script exited | received stage: ${stage}, ${STAGE_MEANING[stage]}`,
    `exit ${evidence.code}, signal ${evidence.signal ?? 'none'}, after ${Math.round(evidence.elapsedMs)}ms; ${first}`,
    `events: ${events}`,
    `port ${evidence.port}: ${evidence.portState}`,
    `loadavg: ${evidence.load.map((value) => value.toFixed(2)).join(' ')}`,
    `stdout: ${evidence.stdout || '(empty)'}`,
    `stderr: ${evidence.stderr || '(empty)'}`,
  ].join('\n');
}

/** A stream's full text and when its first chunk arrived. */
export interface TimedText {
  readonly text: string;
  /** Milliseconds from `startedAt` to the first chunk; `null` for an empty stream. */
  readonly firstChunkMs: number | null;
}

/**
 * Reads a stream to its end and records when the first byte came, so a log can tell a script that
 * was silent for 10 s from one that spoke at once and then stalled.
 *
 * @example
 * const { text, firstChunkMs } = await readTimedText(child.stdout, performance.now());
 */
export async function readTimedText(
  stream: ReadableStream<Uint8Array>,
  startedAt: number
): Promise<TimedText> {
  const decoder = new TextDecoder();
  let text = '';
  let firstChunkMs: number | null = null;
  for await (const chunk of stream) {
    firstChunkMs ??= Math.round(performance.now() - startedAt);
    text += decoder.decode(chunk, { stream: true });
  }
  return { text: text + decoder.decode(), firstChunkMs };
}

/**
 * Says whether a loopback port can be bound now and, when it cannot, which process listens on it
 * (`ss`, where the host has it).
 *
 * @example
 * describePortHolder(43123); // 'free now' | 'bound by another listener: LISTEN ... users:(("node",pid=7,fd=21))'
 */
export function describePortHolder(port: number): string {
  try {
    // A forced stop of a server that served nothing settles at once; the probe awaits no result.
    void Bun.serve({ hostname: '127.0.0.1', port, fetch: () => new Response() }).stop(true);
    return 'free now';
  } catch (caught) {
    const reason = caught instanceof Error ? caught.message : String(caught);
    return `not bindable now (${reason}); ${listeningProcesses(port)}`;
  }
}

function listeningProcesses(port: number): string {
  try {
    const result = Bun.spawnSync(['ss', '-ltnpH', `sport = :${port}`], {
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 2_000,
    });
    const listing = result.stdout.toString().trim();
    return listing ? `listeners: ${listing}` : 'ss listed no listener';
  } catch {
    return 'ss is not available to name the holder';
  }
}
