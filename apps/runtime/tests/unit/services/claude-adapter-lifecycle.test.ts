/**
 * The Claude adapter's turn lifecycle, driven against a scripted process.
 *
 * `claude-adapter.test.ts` covers the decisions that need no process — argv, the
 * permission matrix, what `auth status` may become. What it cannot reach is the
 * part of the adapter that only exists while a run is in flight: whether a turn
 * that *fails* still reaches a terminal event, and what a run's `system/init` is
 * allowed to change about the session behind it.
 *
 * The transport is scripted; the bytes are not. Every stream line comes from
 * `claude-read-turn.jsonl`, the recording the reducer suite is built on, so what
 * the adapter parses is real vendor output. Only the pipe is faked — the three
 * failures worth pinning down (a line over the reader's byte limit, an aborted
 * read, an EPIPE on the prompt write) are each slow or racy to provoke from a
 * real child, and `external-agent-process.test.ts` already drives the real pipes
 * against a real subprocess.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ExternalAgentConfiguration,
  ExternalAgentEvent,
} from '@mangostudio/shared/external-agents';
import type {
  ExternalAgentAdapterContext,
  ExternalAgentTurnStream,
} from '../../../src/services/external-agents/adapter';
import { ClaudeCodeAdapter } from '../../../src/services/external-agents/claude/adapter';
import type { ExternalAgentManagedProcess } from '../../../src/services/external-agents/process';
import { CLAUDE_HELP_LINES } from '../../support/claude-help';

const RECORDED = readFileSync(
  join(import.meta.dir, '../../support/fixtures/claude-read-turn.jsonl'),
  'utf8'
)
  .trim()
  .split('\n');

/** The recorded run's `system/init`, and the session id it reports. */
const RECORDED_INIT = RECORDED[0];
const RECORDED_SESSION_ID = 'b01414e7-4b4b-43a2-9109-a33e21664340';

/**
 * The same record with the one field a `2.1.226` recording cannot have.
 *
 * `terminal_slash_commands` arrived after this recording was taken, and the
 * adapter withholds the whole catalog without it — deliberately, since that
 * build announces `doctor` and `color` as ordinary commands. A test about what
 * the catalog does on the wire needs a run that stated its exclusions, so the
 * empty list is added here rather than faking a whole init record.
 */
const RECORDED_INIT_WITH_EXCLUSIONS = JSON.stringify({
  ...(JSON.parse(RECORDED_INIT ?? '{}') as Record<string, unknown>),
  terminal_slash_commands: [],
});

/**
 * The recording up to the point where the `Read` call is open and its result has
 * not arrived. A failure here has an activity to close.
 */
const UP_TO_OPEN_TOOL_CALL = RECORDED.slice(0, 26);

const MINTED_SESSION_ID = 'minted-session-id';
const VERSION_LINE = '2.1.226 (Claude Code)';
const SUBSCRIPTION_AUTH = JSON.stringify({
  loggedIn: true,
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
  subscriptionType: 'max',
});

const CONFIGURATION: ExternalAgentConfiguration = {
  level: 'default',
  routing: 'user',
  workspaceRoots: ['/work/repo'],
};

/** What one scripted process does when the adapter drives it. */
interface ProcessScript {
  readonly lines?: readonly string[];
  /** Thrown by the reader once the scripted lines run out. */
  readonly readError?: Error;
  /** Rejects the prompt write, the way a vendor that died at startup does. */
  readonly writeError?: Error;
  /** Parks the reader instead of ending it, leaving the turn in flight. */
  readonly hold?: Promise<void>;
  readonly exitCode?: number;
  readonly stderr?: string;
}

interface ScriptedProcess {
  readonly process: ExternalAgentManagedProcess;
  readonly writes: unknown[];
  terminated(): number;
}

function scriptedProcess(script: ProcessScript): ScriptedProcess {
  const pending = [...(script.lines ?? [])];
  const writes: unknown[] = [];
  let terminations = 0;

  const process: ExternalAgentManagedProcess = {
    pid: 4242,
    stdout: {
      async next() {
        const line = pending.shift();
        if (line !== undefined) return { kind: 'line', line };
        if (script.readError) throw script.readError;
        if (script.hold) await script.hold;
        return { kind: 'eof' };
      },
      close() {
        pending.length = 0;
      },
    },
    exit: Promise.resolve({ code: script.exitCode ?? 0, signal: null }),
    writeLine(value) {
      writes.push(value);
      return script.writeError ? Promise.reject(script.writeError) : Promise.resolve();
    },
    endInput() {
      // The scripted reader ends itself; there is no stdin here to close.
    },
    stderrTail: () => script.stderr ?? '',
    terminate() {
      terminations += 1;
      return Promise.resolve();
    },
  };

  return { process, writes, terminated: () => terminations };
}

interface Harness {
  readonly context: ExternalAgentAdapterContext;
  /** Every turn argv, in order. Probe launches are not recorded. */
  readonly turnArgv: Array<readonly string[]>;
  readonly turns: ScriptedProcess[];
}

/**
 * A context whose `spawn` answers the two probes `openSession` runs, then hands
 * out the scripted turn processes in order.
 */
function harness(turnScripts: readonly ProcessScript[]): Harness {
  const queued = [...turnScripts];
  const turnArgv: Array<readonly string[]> = [];
  const turns: ScriptedProcess[] = [];

  const context: ExternalAgentAdapterContext = {
    signal: new AbortController().signal,
    executablePath: '/usr/bin/claude',
    environment: {},
    spawn({ argv }) {
      if (argv.includes('--version')) return scriptedProcess({ lines: [VERSION_LINE] }).process;
      if (argv.includes('--help'))
        return scriptedProcess({ lines: [...CLAUDE_HELP_LINES] }).process;
      if (argv.includes('auth')) return scriptedProcess({ lines: [SUBSCRIPTION_AUTH] }).process;
      turnArgv.push(argv);
      const turn = scriptedProcess(queued.shift() ?? {});
      turns.push(turn);
      return turn.process;
    },
  };

  return { context, turnArgv, turns };
}

/** Opens a session and hands back the adapter that owns it. */
async function openSession(turnScripts: readonly ProcessScript[]) {
  const harnessed = harness(turnScripts);
  const adapter = new ClaudeCodeAdapter({
    newSessionId: () => MINTED_SESSION_ID,
    readManagedSettings: () => Promise.resolve({}),
  });
  await adapter.openSession({
    params: {
      sessionId: 'chat-1',
      targetId: 'claude',
      workspacePath: '/work/repo',
      configuration: CONFIGURATION,
      resumeMode: 'fallback',
      timeoutMs: 60_000,
    },
    context: harnessed.context,
  });
  return { adapter, ...harnessed };
}

function startTurn(
  adapter: ClaudeCodeAdapter,
  context: ExternalAgentAdapterContext,
  overrides: { readonly configuration?: ExternalAgentConfiguration; readonly id?: string } = {}
): ExternalAgentTurnStream {
  return adapter.startTurn({
    nativeSessionId: MINTED_SESSION_ID,
    params: {
      sessionId: 'chat-1',
      clientMessageId: overrides.id ?? 'message-1',
      input: 'read the file',
      configuration: overrides.configuration ?? CONFIGURATION,
    },
    context,
  });
}

async function collect(stream: ExternalAgentTurnStream): Promise<ExternalAgentEvent[]> {
  const events: ExternalAgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

/** The recorded init record with fields replaced, so the input stays real output. */
function patchedInit(patch: Record<string, unknown>): string {
  return JSON.stringify({ ...(JSON.parse(RECORDED_INIT) as Record<string, unknown>), ...patch });
}

function argumentAfter(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index < 0 ? undefined : argv[index + 1];
}

describe('a turn that runs to a result', () => {
  it('streams the recorded turn and closes with completed', async () => {
    const { adapter, context, turns } = await openSession([{ lines: RECORDED }]);
    const events = await collect(startTurn(adapter, context));

    expect(events[0]).toMatchObject({ type: 'session_started', sessionId: RECORDED_SESSION_ID });
    expect(events.at(-1)).toMatchObject({ type: 'completed' });
    expect(turns[0]?.terminated()).toBe(1);
  });

  /** The prompt travels on stdin, and nothing is allowed to put it in argv. */
  it('writes the prompt to stdin exactly once', async () => {
    const { adapter, context, turns, turnArgv } = await openSession([{ lines: RECORDED }]);
    await collect(startTurn(adapter, context));

    expect(turns[0]?.writes).toHaveLength(1);
    expect(turnArgv[0]?.join(' ')).not.toContain('read the file');
  });
});

/**
 * The regression behind the `catch` in `#runTurn`.
 *
 * `finally` closes the channel and `TurnChannel` drops every push after that, so
 * an error raised inside the try that was only handled by the caller's `.catch`
 * produced a turn ending with **no** terminal event at all. The supervisor saw
 * the iterator stop and emitted nothing, which left the transcript's activity
 * pills spinning on a turn that was already dead.
 */
describe('a turn that fails mid-flight', () => {
  const FAILURES: Array<[string, ProcessScript]> = [
    [
      'a stdout line over the reader byte limit',
      {
        lines: RECORDED.slice(0, 5),
        readError: new Error('exceeded the 1048576-byte line limit.'),
      },
    ],
    [
      'a read aborted by the turn signal',
      {
        lines: RECORDED.slice(0, 5),
        readError: new DOMException('External agent read cancelled.', 'AbortError'),
      },
    ],
    [
      'an EPIPE writing the prompt',
      { writeError: Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }) },
    ],
  ];

  it.each(FAILURES)('ends the stream with an error on %s', async (_label, script) => {
    const { adapter, context, turns } = await openSession([script]);
    const events = await collect(startTurn(adapter, context));

    expect(events.at(-1)).toMatchObject({ type: 'error' });
    expect(turns[0]?.terminated()).toBe(1);
  });

  it('cancels the activity a failure left open rather than leaving it running', async () => {
    const { adapter, context } = await openSession([
      { lines: UP_TO_OPEN_TOOL_CALL, readError: new Error('exceeded the byte limit.') },
    ]);
    const events = await collect(startTurn(adapter, context));

    expect(events.some((event) => event.type === 'activity_started')).toBe(true);
    expect(events.filter((event) => event.type === 'activity_completed')).toEqual([
      expect.objectContaining({ result: { status: 'cancelled' } }),
    ]);
    expect(events.at(-1)).toMatchObject({ type: 'error' });
  });

  /** A process that ended without a `result` still has to reach a terminal event. */
  it('ends the stream with an error when the process stops before a result', async () => {
    const { adapter, context } = await openSession([
      { lines: RECORDED.slice(0, 5), exitCode: 1, stderr: 'claude: unknown flag' },
    ]);
    const events = await collect(startTurn(adapter, context));

    expect(events.at(-1)).toMatchObject({ type: 'error', error: { code: 'claude-no-result' } });
  });
});

/**
 * A cancel is something the user asked for, not a failure. `cancel` finishes the
 * channel itself, and the turn must not append an error behind it.
 */
describe('a cancelled turn', () => {
  it('closes the stream without putting a failure in the transcript', async () => {
    const hold = Promise.withResolvers<void>();
    const { adapter, context } = await openSession([
      { lines: [RECORDED_INIT_WITH_EXCLUSIONS], hold: hold.promise },
    ]);
    const iterator = startTurn(adapter, context)[Symbol.asyncIterator]();

    expect((await iterator.next()).value).toMatchObject({ type: 'session_started' });
    // The same `system/init` record also carries the run's command catalog, so
    // it is already queued behind the session event before the cancel lands.
    expect((await iterator.next()).value).toMatchObject({ type: 'commands_available' });
    await adapter.cancel({
      sessionId: 'chat-1',
      nativeSessionId: MINTED_SESSION_ID,
      nativeTurnId: 'message-1',
      reason: 'requested',
    });

    expect(await iterator.next()).toMatchObject({ done: true });
    hold.resolve();
  });
});

/**
 * What `system/init` may change about the session behind the run.
 *
 * Both assertions here are regressions. The session id is the whole continuity
 * mechanism, and the permission mode is the difference between being asked and
 * not being asked.
 */
describe('session state folded back from a run', () => {
  /**
   * `established` used to be set only when a `result` arrived. A turn cancelled
   * or killed after Claude created the conversation on disk then rebuilt argv
   * with `--session-id <same uuid>`, which the CLI refuses because the id is
   * already in use — and since the id never changed, the chat never recovered.
   */
  it('resumes a session the run created even when no result arrived', async () => {
    const { adapter, context, turnArgv } = await openSession([
      { lines: [RECORDED_INIT] },
      { lines: RECORDED },
    ]);

    await collect(startTurn(adapter, context));
    expect(argumentAfter(turnArgv[0] ?? [], '--session-id')).toBe(MINTED_SESSION_ID);

    await collect(startTurn(adapter, context, { id: 'message-2' }));
    expect(turnArgv[1]).not.toContain('--session-id');
    expect(argumentAfter(turnArgv[1] ?? [], '--resume')).toBe(RECORDED_SESSION_ID);
  });

  it('resumes after a cancelled turn rather than minting the same id again', async () => {
    const hold = Promise.withResolvers<void>();
    const { adapter, context, turnArgv } = await openSession([
      { lines: [RECORDED_INIT], hold: hold.promise },
      { lines: RECORDED },
    ]);
    const iterator = startTurn(adapter, context)[Symbol.asyncIterator]();
    await iterator.next();
    await adapter.cancel({
      sessionId: 'chat-1',
      nativeSessionId: MINTED_SESSION_ID,
      nativeTurnId: 'message-1',
      reason: 'requested',
    });

    await collect(startTurn(adapter, context, { id: 'message-2' }));
    expect(argumentAfter(turnArgv[1] ?? [], '--resume')).toBe(RECORDED_SESSION_ID);
    hold.resolve();
  });

  /**
   * Every run is launched with an explicit `--permission-mode`, so `init` echoes
   * back the mode MangoStudio chose rather than the account's own default.
   * Folding that echo into `effectiveDefaultIsAuto` meant one turn at
   * `auto-review` taught the session that plain `default` also meant `auto` — a
   * user who asked to be asked would silently stop being asked.
   */
  it('never lets an init echo widen a later turn to auto', async () => {
    const { adapter, context, turnArgv } = await openSession([
      { lines: [patchedInit({ permissionMode: 'auto' })] },
      { lines: RECORDED },
    ]);

    await collect(
      startTurn(adapter, context, {
        configuration: { ...CONFIGURATION, routing: 'auto-review' },
      })
    );
    expect(argumentAfter(turnArgv[0] ?? [], '--permission-mode')).toBe('auto');

    await collect(startTurn(adapter, context, { id: 'message-2' }));
    expect(argumentAfter(turnArgv[1] ?? [], '--permission-mode')).toBe('manual');
  });
});

/**
 * The probe's two verdicts, seen from discovery rather than from the parser.
 *
 * These are what a user actually meets: a greyed row that names an upgrade, or
 * a working row on a build older than the pin. Both are decided by reading the
 * binary, which is the whole point — the version number is the fallback.
 */
describe('discovery reads the binary rather than the pin', () => {
  function discoveryHarness(options: {
    readonly version: string;
    readonly help: readonly string[];
  }): ExternalAgentAdapterContext {
    return {
      signal: new AbortController().signal,
      executablePath: '/usr/bin/claude',
      environment: {},
      spawn({ argv }) {
        if (argv.includes('--version'))
          return scriptedProcess({ lines: [options.version] }).process;
        if (argv.includes('--help')) return scriptedProcess({ lines: [...options.help] }).process;
        return scriptedProcess({ lines: [SUBSCRIPTION_AUTH] }).process;
      },
    };
  }

  const adapter = () => new ClaudeCodeAdapter({ readManagedSettings: () => Promise.resolve({}) });

  it('keeps a build older than the pin when every flag it passes is there', async () => {
    const descriptor = await adapter().discover(
      discoveryHarness({ version: '2.1.150 (Claude Code)', help: CLAUDE_HELP_LINES })
    );

    expect(descriptor.unavailableReason).toBeUndefined();
    expect(descriptor.requiredVersion).toBeUndefined();
    expect(descriptor.supportedConfigurations.some((entry) => entry.supported)).toBe(true);
  });

  it('names the version to upgrade to when a flag every turn passes is gone', async () => {
    const withoutForwarding = CLAUDE_HELP_LINES.filter(
      (line) => !line.includes('--forward-subagent-text')
    );
    const descriptor = await adapter().discover(
      discoveryHarness({ version: '2.1.227 (Claude Code)', help: withoutForwarding })
    );

    expect(descriptor.unavailableReason).toBe('version-unsupported');
    expect(descriptor.requiredVersion).toBe('2.1.211');
    expect(descriptor.supportedConfigurations.every((entry) => !entry.supported)).toBe(true);
  });

  /**
   * A mode disappearing is narrower than a flag disappearing: it removes the
   * combinations that need it and leaves the rest selectable, rather than
   * taking the target away.
   */
  it('narrows the matrix, not the target, when a permission mode is gone', async () => {
    const withoutManual = CLAUDE_HELP_LINES.map((line) =>
      line.replace('"bypassPermissions", "manual",', '"bypassPermissions",')
    );
    const descriptor = await adapter().discover(
      discoveryHarness({ version: '2.1.227 (Claude Code)', help: withoutManual })
    );
    const byPair = new Map(
      descriptor.supportedConfigurations.map((entry) => [`${entry.level}/${entry.routing}`, entry])
    );

    expect(descriptor.unavailableReason).toBeUndefined();
    expect(byPair.get('default/user')).toMatchObject({
      supported: false,
      unsupportedReasonKey: 'externalAgents.unsupported.claudeModeMissing',
    });
    expect(byPair.get('read-only/user')?.supported).toBe(true);
  });
});
