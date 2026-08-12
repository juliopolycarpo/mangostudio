/**
 * A scriptable stand-in for `codex app-server`, wired to the production client.
 *
 * The adapter under test is the real one, and so is the JSON-RPC client, the id
 * correlation and the reducer. Only the vendor process is fake — and only the
 * OS boundary, which `external-agent-process.test.ts` already covers from every
 * angle that matters (partial lines, byte caps, stderr bounds, tree teardown).
 *
 * What this fake exists to exercise is the part a stubbed client could never
 * reach: Codex **asks MangoStudio things and blocks until answered**. The
 * scenarios below block exactly where the real server blocks, so a turn that
 * never answers a server request hangs here the same way it would in
 * production.
 */

import type { ExternalAgentManagedProcess } from '../../src/services/external-agents/process';
import {
  agentMessageDelta,
  agentMessageItem,
  commandApprovalParams,
  commandExecutionItem,
  enteredReviewModeItem,
  errorNotification,
  exitedReviewModeItem,
  fileChangeApprovalParams,
  itemCompleted,
  itemStarted,
  modelFixture,
  permissionProfiles,
  reasoningItem,
  reasoningSummaryDelta,
  reviewStartResponse,
  THREAD_ID,
  TURN_ID,
  threadListResponse,
  threadStartResponse,
  tokenUsageUpdated,
  turnCompleted,
  turnStartResponse,
  userMessageItem,
} from './codex-fixtures';

export type CodexScenario =
  | 'text'
  | 'reasoning'
  | 'command-approval'
  | 'file-approval'
  | 'host-tool-call'
  | 'unknown-additive'
  | 'error'
  | 'resume-rejected'
  | 'config-override'
  | 'profile-disallowed'
  | 'handshake-refused';

export interface FakeCodexOptions {
  readonly scenario?: CodexScenario;
  /** What `codex --version` prints. Drives the version gate. */
  readonly versionBanner?: string;
  /**
   * Delay before `turn/start` answers, which is the window a cancel can land in
   * while Codex has accepted the turn and MangoStudio does not yet know its id.
   */
  readonly turnStartDelayMs?: number;
  /** How many pages `model/list` serves before its cursor goes null. */
  readonly modelPages?: number;
  /**
   * Holds the turn open — no outstanding server request, just active — until
   * `resumeTurn()` is called. For exercising something mid-turn that a
   * blocking approval would race: `turn/steer` and `turn/interrupt` both
   * need Codex to have named the turn without also holding the JSON-RPC pump
   * hostage on an unanswered request.
   */
  readonly pauseBeforeCompletion?: boolean;
  /**
   * What `review/start` answers with as `reviewThreadId`. Defaults to the
   * thread that asked, which is what inline delivery returns; a different value
   * is the detached answer the adapter must refuse.
   */
  readonly reviewThreadId?: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The vendor half of the conversation.
 *
 * Everything it emits is built by the fixture factories, so it speaks the
 * pinned contract's shapes rather than shapes a test author remembered.
 */
/** How the fixture answers the next `turn/steer` call. */
export type CodexSteerBehavior =
  | 'accepted'
  | 'not-steerable'
  | 'precondition-failed'
  | 'unknown-error';

export class FakeCodexServer {
  readonly #scenario: CodexScenario;
  readonly #send: (message: unknown) => void;
  readonly #turnStartDelayMs: number;
  readonly #modelPages: number;
  readonly #pauseBeforeCompletion: boolean;
  readonly #reviewThreadId: string;
  /** Answers the adapter gave to server→client requests, by request id. */
  readonly answers = new Map<string, unknown>();
  /** Every method the adapter called, in order. */
  readonly calls: Array<{ method: string; params: unknown }> = [];
  #nextServerRequestId = 9000;
  #steerBehavior: CodexSteerBehavior = 'accepted';
  /** The `turnId` a steer answers with once accepted, e.g. after continuing under a new one. */
  #steerTurnId = TURN_ID;
  #resumeTurn?: () => void;

  constructor(send: (message: unknown) => void, options: FakeCodexOptions = {}) {
    this.#send = send;
    this.#scenario = options.scenario ?? 'text';
    this.#turnStartDelayMs = options.turnStartDelayMs ?? 0;
    this.#modelPages = options.modelPages ?? 1;
    this.#pauseBeforeCompletion = options.pauseBeforeCompletion ?? false;
    this.#reviewThreadId = options.reviewThreadId ?? THREAD_ID;
  }

  /** Lets a turn paused by `pauseBeforeCompletion` proceed to its final message and `turn/completed`. */
  resumeTurn(): void {
    this.#resumeTurn?.();
  }

  /** Configures how the *next* `turn/steer` call is answered. */
  setSteerBehavior(behavior: CodexSteerBehavior, turnId?: string): void {
    this.#steerBehavior = behavior;
    if (turnId !== undefined) this.#steerTurnId = turnId;
  }

  /** Whether the adapter ever asked for a method, for interrupt assertions. */
  called(method: string): boolean {
    return this.calls.some((call) => call.method === method);
  }

  receive(line: string): void {
    const message = JSON.parse(line) as {
      id?: unknown;
      method?: string;
      result?: unknown;
      error?: unknown;
    };
    // A reply to one of our server→client requests.
    if (message.method === undefined && message.id !== undefined) {
      this.answers.set(String(message.id), message.error ?? message.result);
      return;
    }
    if (typeof message.method !== 'string') return;
    this.calls.push({ method: message.method, params: (message as { params?: unknown }).params });
    this.#handle(message.id, message.method);
  }

  #notify(method: string, params: unknown): void {
    this.#send({ jsonrpc: '2.0', method, params });
  }

  #respond(id: unknown, result: unknown): void {
    this.#send({ jsonrpc: '2.0', id, result });
  }

  #fail(id: unknown, code: number, message: string, data?: unknown): void {
    this.#send({
      jsonrpc: '2.0',
      id,
      error: { code, message, ...(data !== undefined ? { data } : {}) },
    });
  }

  /** Issue a server→client request and return its id, as the real server does. */
  #ask(method: string, params: unknown): string {
    const id = `srv-${this.#nextServerRequestId++}`;
    this.#send({ jsonrpc: '2.0', id, method, params });
    return id;
  }

  #handle(id: unknown, method: string): void {
    switch (method) {
      case 'initialize':
        if (this.#scenario === 'handshake-refused') {
          this.#fail(id, -32000, 'initialize refused by fixture');
          return;
        }
        this.#respond(id, {
          userAgent: 'fixture/0.147.0',
          codexHome: '/tmp/codex',
          platformFamily: 'unix',
          platformOs: 'linux',
        });
        return;
      case 'initialized':
        return;
      case 'account/read':
        this.#respond(id, {
          account: { type: 'chatgpt', email: 'someone@example.com', planType: 'plus' },
          requiresOpenaiAuth: true,
        });
        return;
      case 'model/list': {
        // Cursor-paginated exactly as the vendor is: one model per page, and a
        // cursor until the last one. A client that reads `data` once and stops
        // sees only the first model.
        const cursor = (this.calls.at(-1)?.params as { cursor?: string } | undefined)?.cursor;
        const page = cursor === undefined ? 0 : Number(cursor);
        const last = page >= this.#modelPages - 1;
        this.#respond(id, {
          data: [modelFixture(page === 0 ? 'gpt-5.6-sol' : `model-page-${page}`)],
          nextCursor: last ? null : String(page + 1),
        });
        return;
      }
      case 'permissionProfile/list':
        this.#respond(id, {
          data:
            this.#scenario === 'profile-disallowed'
              ? permissionProfiles({ ':danger-full-access': false })
              : permissionProfiles(),
          nextCursor: null,
        });
        return;
      case 'thread/list':
        this.#respond(id, threadListResponse());
        return;
      case 'thread/resume':
        if (this.#scenario === 'resume-rejected') {
          this.#fail(id, -32001, 'thread not found');
          return;
        }
        this.#respond(id, threadStartResponse());
        return;
      case 'thread/start':
        this.#respond(
          id,
          // The config-layer override: the caller asked for one model and
          // Codex's own configuration answers with another.
          this.#scenario === 'config-override'
            ? threadStartResponse({ model: 'gpt-5.6-overridden', reasoningEffort: 'high' })
            : threadStartResponse()
        );
        return;
      case 'turn/start':
        if (this.#turnStartDelayMs > 0) {
          // The vendor has accepted the turn; only its id is still in flight.
          void sleep(this.#turnStartDelayMs).then(() => {
            this.#respond(id, turnStartResponse());
            void this.#runTurn();
          });
          return;
        }
        this.#respond(id, turnStartResponse());
        void this.#runTurn();
        return;
      case 'review/start':
        // Inline delivery answers with the thread the review was asked for.
        // `reviewThreadId` overrides that, which is the detached case the
        // adapter has to refuse rather than stream onto.
        this.#respond(id, reviewStartResponse(this.#reviewThreadId));
        void this.#runReview();
        return;
      case 'turn/interrupt':
        this.#respond(id, {});
        return;
      case 'turn/steer':
        switch (this.#steerBehavior) {
          case 'not-steerable':
            this.#fail(id, -32000, 'the active turn is not steerable', {
              codexErrorInfo: { activeTurnNotSteerable: { turnKind: 'review' } },
            });
            return;
          case 'precondition-failed':
            // Codex's own shape for this precondition failure was never
            // captured live — see `steerRejectionReason` in the adapter — so
            // the fixture answers with an ordinary, unstructured error, which
            // is the one fact the adapter can actually rely on: no
            // `codexErrorInfo` naming the reason.
            this.#fail(id, -32000, 'expectedTurnId does not match the active turn');
            return;
          case 'unknown-error':
            this.#fail(id, -32000, 'something else went wrong');
            return;
          default:
            this.#respond(id, { turnId: this.#steerTurnId });
        }
        return;
      default:
        this.#fail(id, -32601, `fixture does not implement ${method}`);
    }
  }

  /**
   * A review turn as Codex runs it: the bracketing review-mode items around the
   * verdict, then the same completion any other turn ends with.
   */
  async #runReview(): Promise<void> {
    this.#notify('turn/started', { threadId: THREAD_ID, turn: turnStartResponse().turn });
    const entered = enteredReviewModeItem('item-review-in', 'uncommitted changes');
    this.#notify('item/started', itemStarted(entered));
    this.#notify('item/completed', itemCompleted(entered));

    if (this.#pauseBeforeCompletion) {
      await new Promise<void>((resolve) => {
        this.#resumeTurn = resolve;
      });
    }

    const verdict = agentMessageItem('item-review-msg', 'P1: the retry loop never exits.');
    this.#notify('item/started', itemStarted(verdict));
    this.#notify('item/completed', itemCompleted(verdict));
    const exited = exitedReviewModeItem('item-review-out', 'uncommitted changes');
    this.#notify('item/started', itemStarted(exited));
    this.#notify('item/completed', itemCompleted(exited));
    this.#notify('turn/completed', turnCompleted());
  }

  async #runTurn(): Promise<void> {
    this.#notify('thread/status/changed', { threadId: THREAD_ID, status: { type: 'active' } });
    this.#notify('turn/started', { threadId: THREAD_ID, turn: turnStartResponse().turn });

    // The echo Codex always sends back and MangoStudio always drops.
    const echo = userMessageItem('item-user', 'hello');
    this.#notify('item/started', itemStarted(echo));
    this.#notify('item/completed', itemCompleted(echo));

    if (this.#pauseBeforeCompletion) {
      await new Promise<void>((resolve) => {
        this.#resumeTurn = resolve;
      });
    }

    if (this.#scenario === 'command-approval' || this.#scenario === 'file-approval') {
      const requestId =
        this.#scenario === 'command-approval'
          ? this.#ask(
              'item/commandExecution/requestApproval',
              commandApprovalParams('rm -rf build')
            )
          : this.#ask('item/fileChange/requestApproval', fileChangeApprovalParams());
      // Blocks exactly where the vendor blocks: until MangoStudio answers.
      while (!this.answers.has(requestId)) await sleep(2);
      const item = commandExecutionItem('item-cmd', 'rm -rf build');
      this.#notify('item/started', itemStarted(item));
      this.#notify('item/completed', itemCompleted(item));
    }

    if (this.#scenario === 'host-tool-call') {
      const requestId = this.#ask('item/tool/call', {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        callId: 'call-1',
        namespace: null,
        tool: 'write_file',
        arguments: { path: '/etc/passwd' },
      });
      while (!this.answers.has(requestId)) await sleep(2);
    }

    if (this.#scenario === 'reasoning') {
      const reasoning = reasoningItem('item-think', ['Considering']);
      this.#notify('item/started', itemStarted(reasoning));
      this.#notify(
        'item/reasoning/summaryTextDelta',
        reasoningSummaryDelta('item-think', 'Considering')
      );
      this.#notify('item/completed', itemCompleted(reasoning));
    }

    if (this.#scenario === 'unknown-additive') {
      // A notification and an item type from a Codex newer than the pin.
      this.#notify('thread/somethingNew/updated', { threadId: THREAD_ID, turnId: TURN_ID });
      const future = { type: 'quantumTool', id: 'item-future' } as never;
      this.#notify('item/started', itemStarted(future));
      this.#notify('item/completed', itemCompleted(future));
    }

    if (this.#scenario === 'error') {
      this.#notify('error', errorNotification('Usage limit reached'));
      this.#notify('turn/completed', turnCompleted('failed'));
      return;
    }

    this.#notify('item/started', itemStarted(agentMessageItem('item-msg', '')));
    this.#notify('item/agentMessage/delta', agentMessageDelta('item-msg', 'MANGO'));
    this.#notify('item/agentMessage/delta', agentMessageDelta('item-msg', '_OK'));
    this.#notify('item/completed', itemCompleted(agentMessageItem('item-msg', 'MANGO_OK')));
    this.#notify('thread/tokenUsage/updated', tokenUsageUpdated());
    this.#notify('thread/status/changed', { threadId: THREAD_ID, status: { type: 'idle' } });
    this.#notify('turn/completed', turnCompleted());
  }
}

export interface FakeCodexProcess {
  readonly managed: ExternalAgentManagedProcess;
  readonly server: FakeCodexServer;
  readonly terminated: () => boolean;
}

/**
 * An `ExternalAgentManagedProcess` whose other end is `FakeCodexServer`.
 *
 * The line reader mirrors the real one's contract exactly — `next` resolves
 * `line`, `timeout` or `eof`, and honours an abort signal — because the
 * production client polls it in a loop and a fake that answered differently
 * would let a real bug in that loop pass.
 */
export function createFakeCodexProcess(options: FakeCodexOptions = {}): FakeCodexProcess {
  const lines: string[] = [];
  const waiters = new Set<() => void>();
  let ended = false;
  let terminated = false;

  const wake = () => {
    for (const waiter of [...waiters]) waiter();
    waiters.clear();
  };
  const server = new FakeCodexServer((message) => {
    if (ended) return;
    lines.push(JSON.stringify(message));
    wake();
  }, options);

  let resolveExit: (value: { code: number | null; signal: NodeJS.Signals | null }) => void = () =>
    undefined;
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    resolveExit = resolve;
  });

  const managed: ExternalAgentManagedProcess = {
    pid: -1,
    stdout: {
      async next(timeoutMs, signal) {
        const deadline = Date.now() + Math.max(0, timeoutMs);
        while (true) {
          const line = lines.shift();
          if (line !== undefined) return { kind: 'line', line };
          if (ended) return { kind: 'eof' };
          if (signal?.aborted) {
            throw new DOMException('External agent read cancelled.', 'AbortError');
          }
          const remaining = deadline - Date.now();
          if (remaining <= 0) return { kind: 'timeout' };
          const arrived = await new Promise<boolean>((resolve) => {
            const waiter = () => {
              clearTimeout(timer);
              resolve(true);
            };
            const timer = setTimeout(
              () => {
                waiters.delete(waiter);
                resolve(false);
              },
              Math.min(remaining, 25)
            );
            timer.unref?.();
            waiters.add(waiter);
          });
          if (!arrived && Date.now() >= deadline) return { kind: 'timeout' };
        }
      },
      close() {
        ended = true;
        wake();
      },
    },
    exit,
    writeLine(value) {
      if (terminated) return Promise.reject(new Error('fixture process is gone'));
      server.receive(JSON.stringify(value));
      return Promise.resolve();
    },
    endInput: () => undefined,
    stderrTail: () => '',
    terminate() {
      terminated = true;
      ended = true;
      wake();
      resolveExit({ code: 0, signal: null });
      return Promise.resolve();
    },
  };

  return { managed, server, terminated: () => terminated };
}
