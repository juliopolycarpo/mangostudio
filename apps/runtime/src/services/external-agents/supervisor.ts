import { realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type {
  ExternalAgentAckResult,
  ExternalAgentCancelParams,
  ExternalAgentCloseParams,
  ExternalAgentDiscoverParams,
  ExternalAgentDiscoverResult,
  ExternalAgentEvent,
  ExternalAgentOpenParams,
  ExternalAgentOpenResult,
  ExternalAgentRespondParams,
  ExternalAgentRuntimeDescriptor,
  ExternalAgentTargetId,
  ExternalAgentTurnParams,
  ExternalAgentTurnResult,
} from '@mangostudio/shared/external-agents';
import {
  boundVendorText,
  EXTERNAL_TURN_PAYLOAD_MAX_BYTES,
  ExternalAgentCancelParamsSchema,
  ExternalAgentCloseParamsSchema,
  ExternalAgentDiscoverParamsSchema,
  ExternalAgentDiscoverResultSchema,
  ExternalAgentEventEnvelopeSchema,
  ExternalAgentEventSchema,
  ExternalAgentOpenParamsSchema,
  ExternalAgentOpenResultSchema,
  ExternalAgentRespondParamsSchema,
  ExternalAgentRuntimeDescriptorSchema,
  ExternalAgentTurnParamsSchema,
} from '@mangostudio/shared/external-agents';
import type {
  RuntimeCapabilityAllow,
  RuntimeExternalAgentHealth,
} from '@mangostudio/shared/runtime-home';
import { Value } from '@sinclair/typebox/value';
import type { RuntimeConsentSource } from '../../consent-source';
import { RuntimeToolArgumentError } from '../../errors';
import type { RuntimeEventInput } from '../../host';
import { RUNTIME_EXTERNAL_AGENT_TOPIC } from '../../methods';
import { probingService } from '../probing/service';
import type { ExternalAgentAdapter, ExternalAgentAdapterContext } from './adapter';
import {
  normalizeExternalAgentDescriptor,
  normalizeExternalAgentEvent,
  normalizeExternalAgentOpenResult,
  normalizeExternalAgentTurnId,
} from './normalization';
import {
  buildExternalAgentEnvironment,
  type ExternalAgentManagedProcess,
  spawnExternalAgentProcess,
} from './process';
import {
  assertExternalAgentAdapterConformance,
  type ExternalAgentAdapterRegistry,
} from './registry';

const DEFAULT_SESSION_CAP = 4;
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const DEFAULT_HARD_TURN_TIMEOUT_MS = 60 * 60_000;
const DEFAULT_CONSENT_POLL_MS = 250;
const DEFAULT_CLEANUP_TIMEOUT_MS = 2_000;
const TURN_ERROR_RESERVE_BYTES = 4_096;

interface LiveTurn {
  readonly nativeTurnId: string;
  readonly controller: AbortController;
  payloadBytes: number;
}

interface TurnReceipt {
  readonly fingerprint: string;
  readonly result: Promise<ExternalAgentTurnResult>;
}

interface LiveSession {
  readonly sessionId: string;
  readonly adapter: ExternalAgentAdapter;
  readonly workspacePath: string;
  readonly openedAtMs: number;
  readonly openResult: ExternalAgentOpenResult;
  readonly turns: Map<string, TurnReceipt>;
  readonly processes: Set<ExternalAgentManagedProcess>;
  sequence: number;
  state: 'idle' | 'running' | 'closing';
  activeTurn?: LiveTurn;
  closePromise?: Promise<ExternalAgentAckResult>;
}

interface LateOpenReaper {
  readonly promise: Promise<void>;
  reason: 'requested' | 'consent-revoked' | 'shutdown';
  settled: boolean;
}

export interface ExternalAgentExecutable {
  readonly path?: string;
}

export interface ExternalAgentSupervisorOptions {
  readonly registry: ExternalAgentAdapterRegistry;
  readonly runtimeVersion: string;
  readonly emit: (event: RuntimeEventInput) => void;
  readonly consent: RuntimeConsentSource;
  readonly env?: NodeJS.ProcessEnv;
  readonly sessionCap?: number;
  readonly idleTimeoutMs?: number;
  readonly hardTurnTimeoutMs?: number;
  readonly consentPollMs?: number;
  readonly cleanupTimeoutMs?: number;
  readonly now?: () => number;
  /**
   * Runtime-owner policy evaluated after canonicalization and before any
   * executable lookup or adapter call. Omission is a denial, never allow-all.
   */
  readonly authorizeWorkspace?: (
    canonicalPath: string,
    signal: AbortSignal
  ) => boolean | Promise<boolean>;
  readonly resolveExecutable?: (
    targetId: ExternalAgentTargetId,
    signal: AbortSignal
  ) => Promise<ExternalAgentExecutable>;
}

/** Owns hub session ids, idempotency, deadlines, events, consent and teardown. */
export class ExternalAgentSessionSupervisor {
  readonly #registry: ExternalAgentAdapterRegistry;
  readonly #runtimeVersion: string;
  readonly #emit: (event: RuntimeEventInput) => void;
  readonly #consent: RuntimeConsentSource;
  readonly #env: NodeJS.ProcessEnv;
  readonly #sessionCap: number;
  readonly #idleTimeoutMs: number;
  readonly #hardTurnTimeoutMs: number;
  readonly #consentPollMs: number;
  readonly #cleanupTimeoutMs: number;
  readonly #now: () => number;
  readonly #authorizeWorkspace: (
    canonicalPath: string,
    signal: AbortSignal
  ) => boolean | Promise<boolean>;
  readonly #resolveExecutableOverride?: ExternalAgentSupervisorOptions['resolveExecutable'];
  readonly #sessions = new Map<string, LiveSession>();
  readonly #openings = new Map<string, Promise<ExternalAgentOpenResult>>();
  readonly #openingControllers = new Map<string, AbortController>();
  readonly #openingCloseReasons = new Map<string, 'requested' | 'consent-revoked' | 'shutdown'>();
  readonly #lateOpenReapers = new Map<string, Set<LateOpenReaper>>();
  readonly #processes = new Set<ExternalAgentManagedProcess>();
  readonly #shutdownController = new AbortController();
  #deferredCleanupFailure?: unknown;
  #consentTimer?: ReturnType<typeof setInterval>;
  #consentRefresh?: Promise<void>;
  #closing?: Promise<void>;

  constructor(options: ExternalAgentSupervisorOptions) {
    this.#registry = options.registry;
    this.#runtimeVersion = options.runtimeVersion;
    this.#emit = options.emit;
    this.#consent = options.consent;
    this.#env = options.env ?? process.env;
    this.#sessionCap = options.sessionCap ?? DEFAULT_SESSION_CAP;
    this.#idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.#hardTurnTimeoutMs = options.hardTurnTimeoutMs ?? DEFAULT_HARD_TURN_TIMEOUT_MS;
    this.#consentPollMs = options.consentPollMs ?? DEFAULT_CONSENT_POLL_MS;
    this.#cleanupTimeoutMs = options.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS;
    this.#now = options.now ?? Date.now;
    // Adapters are privileged process launchers. A caller that did not bind
    // them to an explicit workspace policy gets no authorized directory.
    this.#authorizeWorkspace = options.authorizeWorkspace ?? (() => false);
    this.#resolveExecutableOverride = options.resolveExecutable;
  }

  get health(): RuntimeExternalAgentHealth {
    const now = this.#now();
    const liveSessions = [...this.#sessions.values()].map((session) => ({
      sessionId: session.sessionId,
      targetId: session.adapter.targetId,
      ageMs: Math.max(0, now - session.openedAtMs),
      state: session.state,
    }));
    return {
      targets: this.#registry.targetIds,
      liveSessionCount: liveSessions.length,
      liveSessions,
    };
  }

  async discover(
    params: ExternalAgentDiscoverParams,
    requestSignal: AbortSignal
  ): Promise<ExternalAgentDiscoverResult> {
    assertExternalAgentParams('external-agent.discover', ExternalAgentDiscoverParamsSchema, params);
    const descriptors = await Promise.all(
      params.targetIds.map(async (targetId) => {
        const adapter = this.#registry.require(targetId);
        const processes = new Set<ExternalAgentManagedProcess>();
        const controller = linkedDeadline(
          [requestSignal, this.#shutdownController.signal],
          params.timeoutMs
        );
        try {
          const executable = await this.#resolveExecutable(targetId, controller.signal);
          throwIfAborted(controller.signal);
          const rawDescriptor = await raceAbort(
            adapter.discover(
              this.#context(adapter, controller.signal, executable.path, undefined, processes)
            ),
            controller.signal,
            `External-agent discovery for "${targetId}" timed out.`
          );
          const descriptor = normalizeExternalAgentDescriptor(rawDescriptor);
          this.#assertDescriptor(adapter, descriptor);
          return descriptor;
        } finally {
          controller.dispose();
          await this.#terminateProcesses(processes);
        }
      })
    );
    const result = { descriptors };
    if (!Value.Check(ExternalAgentDiscoverResultSchema, result)) {
      throw new Error('External-agent discovery produced an invalid or unbounded result.');
    }
    return result;
  }

  open(
    params: ExternalAgentOpenParams,
    requestSignal: AbortSignal
  ): Promise<ExternalAgentOpenResult> {
    assertExternalAgentParams('external-agent.open', ExternalAgentOpenParamsSchema, params);
    if (this.#closing) {
      return Promise.reject(
        new RuntimeToolArgumentError('The external-agent supervisor is closed.')
      );
    }
    const existing = this.#sessions.get(params.sessionId);
    if (existing) {
      if (existing.adapter.targetId !== params.targetId) {
        throw new RuntimeToolArgumentError(
          `External-agent session "${params.sessionId}" already belongs to another target.`
        );
      }
      return Promise.resolve(existing.openResult);
    }
    const opening = this.#openings.get(params.sessionId);
    if (opening) return opening;
    if (this.#sessions.size + this.#openings.size >= this.#sessionCap) {
      throw new RuntimeToolArgumentError(
        `External-agent session capacity is ${this.#sessionCap}; close a session before opening another.`
      );
    }

    const operationController = new AbortController();
    this.#openingControllers.set(params.sessionId, operationController);
    this.#startConsentWatcher();
    const promise = this.#open(params, requestSignal, operationController.signal).finally(() => {
      this.#openings.delete(params.sessionId);
      this.#openingControllers.delete(params.sessionId);
      this.#openingCloseReasons.delete(params.sessionId);
      this.#stopConsentWatcherWhenIdle();
    });
    this.#openings.set(params.sessionId, promise);
    return promise;
  }

  turn(params: ExternalAgentTurnParams): Promise<ExternalAgentTurnResult> {
    assertExternalAgentParams('external-agent.turn', ExternalAgentTurnParamsSchema, params);
    const session = this.#requireSession(params.sessionId);
    const fingerprint = JSON.stringify(params);
    const receipt = session.turns.get(params.clientMessageId);
    if (receipt) {
      if (receipt.fingerprint !== fingerprint) {
        throw new RuntimeToolArgumentError(
          `clientMessageId "${params.clientMessageId}" was reused with different turn input.`
        );
      }
      return receipt.result;
    }
    if (session.activeTurn) {
      throw new RuntimeToolArgumentError(
        `External-agent session "${params.sessionId}" already has an active turn.`
      );
    }

    const result = this.#startTurn(session, params);
    session.turns.set(params.clientMessageId, { fingerprint, result });
    return result;
  }

  async respond(params: ExternalAgentRespondParams): Promise<ExternalAgentAckResult> {
    assertExternalAgentParams('external-agent.respond', ExternalAgentRespondParamsSchema, params);
    const session = this.#requireSession(params.sessionId);
    await session.adapter.respond({
      ...params,
      nativeSessionId: session.openResult.nativeSessionId,
    });
    return { ok: true };
  }

  async cancel(
    params: ExternalAgentCancelParams,
    reason: 'requested' | 'consent-revoked' | 'timeout' | 'shutdown' = 'requested'
  ): Promise<ExternalAgentAckResult> {
    assertExternalAgentParams('external-agent.cancel', ExternalAgentCancelParamsSchema, params);
    const session = this.#requireSession(params.sessionId);
    session.activeTurn?.controller.abort();
    await session.adapter.cancel({
      ...params,
      nativeSessionId: session.openResult.nativeSessionId,
      reason,
    });
    return { ok: true };
  }

  closeSession(
    params: ExternalAgentCloseParams,
    reason: 'requested' | 'consent-revoked' | 'shutdown' = 'requested'
  ): Promise<ExternalAgentAckResult> {
    assertExternalAgentParams('external-agent.close', ExternalAgentCloseParamsSchema, params);
    const session = this.#sessions.get(params.sessionId);
    if (!session) {
      const opening = this.#openings.get(params.sessionId);
      if (!opening && !this.#lateOpenReapers.has(params.sessionId)) {
        return Promise.resolve({ ok: true });
      }
      this.#openingCloseReasons.set(params.sessionId, reason);
      this.#setLateOpenReason(params.sessionId, reason);
      this.#openingControllers
        .get(params.sessionId)
        ?.abort(abortError('External-agent session was closed while it was opening.'));
      return this.#closeOpening(params, opening, reason);
    }
    if (session.closePromise) return session.closePromise;
    session.state = 'closing';
    session.closePromise = this.#closeSession(session, reason);
    return session.closePromise;
  }

  close(): Promise<void> {
    this.#closing ??= this.#shutdown();
    return this.#closing;
  }

  async #closeOpening(
    params: ExternalAgentCloseParams,
    opening: Promise<ExternalAgentOpenResult> | undefined,
    reason: 'requested' | 'consent-revoked' | 'shutdown'
  ): Promise<ExternalAgentAckResult> {
    try {
      await opening?.catch(() => undefined);
      const registered = this.#sessions.get(params.sessionId);
      if (registered) await this.closeSession(params, reason);
      await this.#awaitLateOpenReapers(
        [params.sessionId],
        `External-agent session "${params.sessionId}" late-open cleanup failed.`
      );
      return { ok: true };
    } finally {
      this.#openingCloseReasons.delete(params.sessionId);
    }
  }

  async #closeSession(
    session: LiveSession,
    reason: 'requested' | 'consent-revoked' | 'shutdown'
  ): Promise<ExternalAgentAckResult> {
    session.activeTurn?.controller.abort(abortError('External-agent session is closing.'));
    const failures: unknown[] = [];
    try {
      if (session.activeTurn) {
        await settleCleanup(
          session.adapter.cancel({
            sessionId: session.sessionId,
            nativeSessionId: session.openResult.nativeSessionId,
            nativeTurnId: session.activeTurn.nativeTurnId,
            reason,
          })
        ).catch(() => undefined);
      }
      await settleCleanup(
        session.adapter.close({
          sessionId: session.sessionId,
          nativeSessionId: session.openResult.nativeSessionId,
          reason,
        })
      );
    } catch (error) {
      failures.push(error);
    } finally {
      try {
        await this.#terminateProcesses(session.processes);
      } catch (error) {
        failures.push(error);
      } finally {
        this.#sessions.delete(session.sessionId);
        this.#stopConsentWatcherWhenIdle();
      }
    }
    throwCleanupFailures(failures, `External-agent session "${session.sessionId}" cleanup failed.`);
    return { ok: true };
  }

  async #open(
    params: ExternalAgentOpenParams,
    requestSignal: AbortSignal,
    operationSignal: AbortSignal
  ): Promise<ExternalAgentOpenResult> {
    const adapter = this.#registry.require(params.targetId);
    const processes = new Set<ExternalAgentManagedProcess>();
    const controller = linkedDeadline(
      [requestSignal, operationSignal, this.#shutdownController.signal],
      params.timeoutMs
    );
    try {
      const workspacePath = await this.#canonicalAuthorizedWorkspace(
        params.workspacePath,
        controller.signal
      );
      for (const root of params.configuration.workspaceRoots) {
        await this.#canonicalAuthorizedWorkspace(root, controller.signal);
      }
      const executable = await raceAbort(
        this.#resolveExecutable(params.targetId, controller.signal),
        controller.signal,
        `Resolving external-agent target "${params.targetId}" timed out.`
      );
      throwIfAborted(controller.signal);
      if (!executable.path) {
        throw new RuntimeToolArgumentError(
          `External-agent executable for "${params.targetId}" is not installed.`
        );
      }
      const rawOpen = adapter.openSession({
        params: { ...params, workspacePath },
        context: this.#context(
          adapter,
          controller.signal,
          executable.path,
          workspacePath,
          processes
        ),
      });
      let rawResult: ExternalAgentOpenResult;
      try {
        rawResult = await raceAbort(
          rawOpen,
          controller.signal,
          `Opening external-agent target "${params.targetId}" timed out.`
        );
      } catch (error) {
        this.#reapLateOpen(
          adapter,
          params.sessionId,
          rawOpen,
          this.#openingCloseReasons.get(params.sessionId) ??
            (this.#closing ? 'shutdown' : 'requested')
        );
        throw error;
      }

      let openResult: ExternalAgentOpenResult;
      try {
        openResult = normalizeExternalAgentOpenResult(rawResult);
        if (!Value.Check(ExternalAgentOpenResultSchema, openResult)) {
          throw new Error(
            `External-agent adapter "${params.targetId}" returned an invalid or unbounded open result.`
          );
        }
        assertExternalAgentAdapterConformance(adapter, openResult.capabilities);
      } catch (error) {
        await this.#closeReturnedOpen(adapter, params.sessionId, rawResult, 'requested');
        throw error;
      }
      if (controller.signal.aborted || this.#closing) {
        await this.#closeReturnedOpen(
          adapter,
          params.sessionId,
          rawResult,
          this.#openingCloseReasons.get(params.sessionId) ??
            (this.#closing ? 'shutdown' : 'consent-revoked')
        );
        throw abortError('External-agent open was cancelled before registration.');
      }
      const session: LiveSession = {
        sessionId: params.sessionId,
        adapter,
        workspacePath,
        openedAtMs: this.#now(),
        openResult,
        turns: new Map(),
        processes,
        sequence: 0,
        state: 'idle',
      };
      this.#sessions.set(params.sessionId, session);
      this.#startConsentWatcher();
      return openResult;
    } catch (error) {
      try {
        await this.#terminateProcesses(processes);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `External-agent open for session "${params.sessionId}" failed during cleanup.`
        );
      }
      throw error;
    } finally {
      controller.dispose();
    }
  }

  #startTurn(
    session: LiveSession,
    params: ExternalAgentTurnParams
  ): Promise<ExternalAgentTurnResult> {
    const controller = new AbortController();
    const stream = session.adapter.startTurn({
      nativeSessionId: session.openResult.nativeSessionId,
      params,
      context: this.#context(
        session.adapter,
        controller.signal,
        undefined,
        session.workspacePath,
        session.processes
      ),
    });
    let nativeTurnId: string;
    try {
      nativeTurnId = normalizeExternalAgentTurnId(stream.nativeTurnId);
    } catch (error) {
      controller.abort(abortError('External-agent adapter returned an invalid turn id.'));
      void settleCleanup(
        session.adapter.cancel({
          sessionId: session.sessionId,
          nativeSessionId: session.openResult.nativeSessionId,
          nativeTurnId: stream.nativeTurnId,
          reason: 'requested',
        })
      ).catch(() => undefined);
      throw error;
    }
    const activeTurn: LiveTurn = { nativeTurnId, controller, payloadBytes: 0 };
    session.activeTurn = activeTurn;
    session.state = 'running';
    void this.#consumeTurn(session, activeTurn, stream);
    return Promise.resolve({ nativeTurnId });
  }

  async #consumeTurn(
    session: LiveSession,
    turn: LiveTurn,
    events: AsyncIterable<ExternalAgentEvent>
  ): Promise<void> {
    const iterator = events[Symbol.asyncIterator]();
    const hardDeadline = this.#now() + this.#hardTurnTimeoutMs;
    try {
      while (!turn.controller.signal.aborted) {
        const hardRemaining = hardDeadline - this.#now();
        if (hardRemaining <= 0) throw new Error('External-agent turn exceeded its hard timeout.');
        const hardDeadlineWins = hardRemaining <= this.#idleTimeoutMs;
        const next = await raceTimeout(
          iterator.next(),
          Math.min(this.#idleTimeoutMs, hardRemaining),
          hardDeadlineWins
            ? 'External-agent turn exceeded its hard timeout.'
            : 'External-agent turn exceeded its idle timeout.'
        );
        if (turn.controller.signal.aborted) break;
        if (next.done) break;
        const event = normalizeExternalAgentEvent(next.value);
        if (!Value.Check(ExternalAgentEventSchema, event)) {
          throw new Error('External-agent adapter emitted an invalid or unbounded event.');
        }
        const eventBytes = Buffer.byteLength(
          JSON.stringify({
            sessionId: session.sessionId,
            nativeTurnId: turn.nativeTurnId,
            sequence: session.sequence + 1,
            emittedAtMs: this.#now(),
            event,
          })
        );
        if (
          turn.payloadBytes + eventBytes >
          EXTERNAL_TURN_PAYLOAD_MAX_BYTES - TURN_ERROR_RESERVE_BYTES
        ) {
          throw new Error('External-agent turn exceeded its persisted payload limit.');
        }
        turn.payloadBytes += eventBytes;
        this.#emitEvent(session, turn.nativeTurnId, event);
      }
    } catch (error) {
      if (!turn.controller.signal.aborted) {
        turn.controller.abort(
          abortError('External-agent turn was cancelled after a stream error.')
        );
        const bounded = boundedErrorMessage(error);
        this.#emitEvent(session, turn.nativeTurnId, {
          type: 'error',
          error: {
            code: 'adapter-stream',
            message: bounded.text,
            ...(bounded.truncated ? { truncated: true } : {}),
          },
        });
        await settleCleanup(
          session.adapter.cancel({
            sessionId: session.sessionId,
            nativeSessionId: session.openResult.nativeSessionId,
            nativeTurnId: turn.nativeTurnId,
            reason: 'timeout',
          })
        ).catch(() => undefined);
      }
    } finally {
      const returned = iterator.return?.();
      if (returned) await settleCleanup(Promise.resolve(returned)).catch(() => undefined);
      if (session.activeTurn === turn) {
        session.activeTurn = undefined;
        if (session.state !== 'closing') session.state = 'idle';
      }
    }
  }

  #emitEvent(session: LiveSession, nativeTurnId: string, event: ExternalAgentEvent): void {
    session.sequence += 1;
    const payload = {
      sessionId: session.sessionId,
      nativeTurnId,
      sequence: session.sequence,
      emittedAtMs: this.#now(),
      event,
    };
    if (!Value.Check(ExternalAgentEventEnvelopeSchema, payload)) {
      session.sequence -= 1;
      throw new Error('External-agent adapter produced an invalid event envelope.');
    }
    this.#emit({
      topic: RUNTIME_EXTERNAL_AGENT_TOPIC,
      streamId: session.sessionId,
      payload,
    });
  }

  #assertDescriptor(
    adapter: ExternalAgentAdapter,
    descriptor: ExternalAgentRuntimeDescriptor
  ): void {
    if (!Value.Check(ExternalAgentRuntimeDescriptorSchema, descriptor)) {
      throw new Error(
        `External-agent adapter "${adapter.targetId}" returned an invalid or unbounded descriptor.`
      );
    }
    if (descriptor.targetId !== adapter.targetId) {
      throw new Error(
        `External-agent adapter "${adapter.targetId}" returned descriptor for "${descriptor.targetId}".`
      );
    }
    assertExternalAgentAdapterConformance(adapter, descriptor.capabilities);
  }

  #context(
    adapter: ExternalAgentAdapter,
    signal: AbortSignal,
    executablePath?: string,
    cwd?: string,
    ownedProcesses?: Set<ExternalAgentManagedProcess>
  ): ExternalAgentAdapterContext {
    const environment = buildExternalAgentEnvironment(this.#env, adapter.vendorEnvironmentKeys);
    const effectiveCwd = cwd ?? process.cwd();
    return {
      signal,
      ...(executablePath ? { executablePath } : {}),
      ...(cwd ? { cwd } : {}),
      environment,
      spawn: (options) => {
        if (signal.aborted) throw abortError('External-agent process launch was cancelled.');
        const managed = spawnExternalAgentProcess({
          ...options,
          cwd: effectiveCwd,
          envSource: environment,
          vendorEnvironmentKeys: adapter.vendorEnvironmentKeys,
        });
        this.#processes.add(managed);
        ownedProcesses?.add(managed);
        void managed.exit.finally(() => {
          this.#processes.delete(managed);
          ownedProcesses?.delete(managed);
        });
        return managed;
      },
    };
  }

  #reapLateOpen(
    adapter: ExternalAgentAdapter,
    sessionId: string,
    result: Promise<ExternalAgentOpenResult>,
    reason: 'requested' | 'consent-revoked' | 'shutdown'
  ): void {
    let reaper: LateOpenReaper;
    const promise = result.then(
      (opened) => this.#closeReturnedOpen(adapter, sessionId, opened, reaper.reason),
      () => undefined
    );
    reaper = { promise, reason, settled: false };
    const sessionReapers = this.#lateOpenReapers.get(sessionId) ?? new Set<LateOpenReaper>();
    sessionReapers.add(reaper);
    this.#lateOpenReapers.set(sessionId, sessionReapers);
    // Pending entries form the lifecycle barrier. A failed entry remains so a
    // later explicit close, consent revocation, or shutdown can surface it.
    void promise.then(
      () => {
        reaper.settled = true;
        sessionReapers.delete(reaper);
        if (sessionReapers.size === 0) this.#lateOpenReapers.delete(sessionId);
        this.#stopConsentWatcherWhenIdle();
      },
      () => {
        reaper.settled = true;
        this.#stopConsentWatcherWhenIdle();
      }
    );
  }

  #setLateOpenReason(
    sessionId: string,
    reason: 'requested' | 'consent-revoked' | 'shutdown'
  ): void {
    for (const reaper of this.#lateOpenReapers.get(sessionId) ?? []) {
      if (!reaper.settled) reaper.reason = reason;
    }
  }

  #hasPendingLateOpenReapers(): boolean {
    for (const reapers of this.#lateOpenReapers.values()) {
      for (const reaper of reapers) {
        if (!reaper.settled) return true;
      }
    }
    return false;
  }

  async #awaitLateOpenReapers(sessionIds: Iterable<string>, message: string): Promise<void> {
    const ids = [...new Set(sessionIds)];
    const entries = ids.flatMap((sessionId) => [...(this.#lateOpenReapers.get(sessionId) ?? [])]);
    if (entries.length === 0) return;

    const results = await raceTimeout(
      Promise.allSettled(entries.map((entry) => entry.promise)),
      this.#cleanupTimeoutMs,
      'External-agent late-open cleanup exceeded its deadline.'
    );
    for (const sessionId of ids) {
      const sessionReapers = this.#lateOpenReapers.get(sessionId);
      if (!sessionReapers) continue;
      for (const entry of entries) sessionReapers.delete(entry);
      if (sessionReapers.size === 0) this.#lateOpenReapers.delete(sessionId);
    }
    this.#stopConsentWatcherWhenIdle();
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);
    throwCleanupFailures(failures, message);
  }

  async #closeReturnedOpen(
    adapter: ExternalAgentAdapter,
    sessionId: string,
    opened: ExternalAgentOpenResult,
    reason: 'requested' | 'consent-revoked' | 'shutdown'
  ): Promise<void> {
    if (typeof opened.nativeSessionId !== 'string' || opened.nativeSessionId.length === 0) return;
    await settleCleanup(
      adapter.close({ sessionId, nativeSessionId: opened.nativeSessionId, reason })
    );
  }

  async #terminateProcesses(processes: Iterable<ExternalAgentManagedProcess>): Promise<void> {
    const results = await Promise.allSettled([...processes].map((managed) => managed.terminate()));
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);
    throwCleanupFailures(failures, 'External-agent process cleanup failed.');
  }

  async #resolveExecutable(
    targetId: ExternalAgentTargetId,
    signal: AbortSignal
  ): Promise<ExternalAgentExecutable> {
    if (this.#resolveExecutableOverride) {
      return this.#resolveExecutableOverride(targetId, signal);
    }
    if (signal.aborted) throw abortError();
    const result = await probingService.probeAgentClis({
      targetIds: [targetId],
      self: { version: this.#runtimeVersion },
    });
    return { path: result.statuses[0]?.effective?.path };
  }

  async #canonicalAuthorizedWorkspace(input: string, signal: AbortSignal): Promise<string> {
    const absolute = resolve(input);
    let canonical: string;
    try {
      const info = await raceAbort(
        stat(absolute),
        signal,
        `External-agent workspace check for "${input}" timed out.`
      );
      if (!info.isDirectory()) throw new Error('not a directory');
      canonical = await raceAbort(
        realpath(absolute),
        signal,
        `External-agent workspace resolution for "${input}" timed out.`
      );
    } catch {
      throwIfAborted(signal);
      throw new RuntimeToolArgumentError(`External-agent workspace "${input}" is not a directory.`);
    }
    if (input !== canonical) {
      throw new RuntimeToolArgumentError(
        `External-agent workspace must be canonical; use "${canonical}".`
      );
    }
    const authorized = await raceAbort(
      Promise.resolve(this.#authorizeWorkspace(canonical, signal)),
      signal,
      `External-agent workspace authorization for "${canonical}" timed out.`
    );
    throwIfAborted(signal);
    if (!authorized) {
      throw new RuntimeToolArgumentError(
        `External-agent workspace "${canonical}" is not authorized for this session.`
      );
    }
    return canonical;
  }

  #requireSession(sessionId: string): LiveSession {
    const session = this.#sessions.get(sessionId);
    if (!session || session.state === 'closing') {
      throw new RuntimeToolArgumentError(`External-agent session "${sessionId}" is not open.`);
    }
    return session;
  }

  #startConsentWatcher(): void {
    if (this.#consentTimer) return;
    this.#consentTimer = setInterval(() => this.#pollConsent(), this.#consentPollMs);
    this.#consentTimer.unref?.();
  }

  #pollConsent(): void {
    if (this.#consentRefresh || this.#closing) return;
    const refresh = this.#refreshConsent();
    this.#consentRefresh = refresh;
    void refresh.then(
      () => this.#finishConsentRefresh(refresh),
      (error: unknown) => {
        this.#deferredCleanupFailure ??= error;
        this.#finishConsentRefresh(refresh);
      }
    );
  }

  #finishConsentRefresh(refresh: Promise<void>): void {
    if (this.#consentRefresh !== refresh) return;
    this.#consentRefresh = undefined;
    this.#stopConsentWatcherWhenIdle();
  }

  #stopConsentWatcherWhenIdle(): void {
    if (
      this.#sessions.size > 0 ||
      this.#openings.size > 0 ||
      this.#hasPendingLateOpenReapers() ||
      !this.#consentTimer
    ) {
      return;
    }
    clearInterval(this.#consentTimer);
    this.#consentTimer = undefined;
  }

  async #refreshConsent(): Promise<void> {
    let allow: RuntimeCapabilityAllow;
    try {
      allow = await this.#consent.refresh();
    } catch {
      allow = { ...this.#consent.current(), externalAgents: false };
    }
    if (allow.externalAgents !== true) {
      const relevantSessionIds = [
        ...new Set([...this.#openingControllers.keys(), ...this.#lateOpenReapers.keys()]),
      ];
      for (const sessionId of relevantSessionIds) {
        this.#setLateOpenReason(sessionId, 'consent-revoked');
      }
      for (const [sessionId, controller] of this.#openingControllers) {
        this.#openingCloseReasons.set(sessionId, 'consent-revoked');
        controller.abort(abortError('External-agent consent was revoked.'));
      }
      await Promise.allSettled(this.#openings.values());
      const results = await Promise.allSettled([
        this.#awaitLateOpenReapers(
          relevantSessionIds,
          'External-agent consent-revocation late-open cleanup failed.'
        ),
        this.#closeAll('consent-revoked'),
      ]);
      const failures = results
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason);
      throwCleanupFailures(failures, 'External-agent consent-revocation cleanup failed.');
    }
  }

  async #closeAll(reason: 'consent-revoked' | 'shutdown'): Promise<void> {
    const sessions = [...this.#sessions.keys()];
    const results = await Promise.allSettled(
      sessions.map((sessionId) => this.closeSession({ sessionId }, reason))
    );
    this.#stopConsentWatcherWhenIdle();
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);
    throwCleanupFailures(failures, 'External-agent session cleanup failed.');
  }

  async #shutdown(): Promise<void> {
    this.#shutdownController.abort(abortError('External-agent supervisor is shutting down.'));
    if (this.#consentTimer) {
      clearInterval(this.#consentTimer);
      this.#consentTimer = undefined;
    }
    for (const [sessionId, controller] of this.#openingControllers) {
      this.#openingCloseReasons.set(sessionId, 'shutdown');
      controller.abort(abortError('External-agent supervisor is shutting down.'));
    }
    for (const sessionId of this.#lateOpenReapers.keys()) {
      this.#setLateOpenReason(sessionId, 'shutdown');
    }
    await Promise.allSettled(this.#openings.values());
    if (this.#consentRefresh) await Promise.allSettled([this.#consentRefresh]);
    const failures =
      this.#deferredCleanupFailure === undefined ? [] : [this.#deferredCleanupFailure];
    this.#deferredCleanupFailure = undefined;
    const lateOpenResult = await Promise.allSettled([
      this.#awaitLateOpenReapers(
        this.#lateOpenReapers.keys(),
        'External-agent shutdown late-open cleanup failed.'
      ),
    ]);
    if (lateOpenResult[0]?.status === 'rejected') failures.push(lateOpenResult[0].reason);
    const cleanupResults = await Promise.allSettled([
      this.#closeAll('shutdown'),
      this.#terminateProcesses(this.#processes),
    ]);
    for (const result of cleanupResults) {
      if (result.status === 'rejected') failures.push(result.reason);
    }
    try {
      throwCleanupFailures(failures, 'External-agent supervisor shutdown cleanup failed.');
    } finally {
      this.#stopConsentWatcherWhenIdle();
    }
  }
}

function throwCleanupFailures(failures: readonly unknown[], message: string): void {
  if (failures.length === 0) return;
  throw new AggregateError(failures, message);
}

function linkedDeadline(
  parents: readonly AbortSignal[],
  timeoutMs: number
): {
  readonly signal: AbortSignal;
  dispose(): void;
} {
  const controller = new AbortController();
  const abort = (event?: Event) => {
    const parent = event?.target;
    controller.abort(
      parent instanceof AbortSignal ? parent.reason : abortError('Deadline exceeded.')
    );
  };
  for (const parent of parents) {
    if (parent.aborted) controller.abort(parent.reason);
    else parent.addEventListener('abort', abort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(abortError('Deadline exceeded.')), timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      for (const parent of parents) parent.removeEventListener('abort', abort);
    },
  };
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal, message: string): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error(message));
  }
  return new Promise((resolvePromise, reject) => {
    const abort = () => reject(signal.reason instanceof Error ? signal.reason : new Error(message));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolvePromise, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function raceTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref?.();
    promise.then(resolvePromise, reject).finally(() => clearTimeout(timer));
  });
}

function boundedErrorMessage(error: unknown) {
  const value = error instanceof Error ? error.message : String(error);
  return boundVendorText(value, 'errorMessage');
}

function abortError(message = 'External-agent operation was cancelled.'): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : abortError();
}

async function settleCleanup(promise: Promise<unknown>): Promise<void> {
  await raceTimeout(
    promise.then(() => undefined),
    DEFAULT_CLEANUP_TIMEOUT_MS,
    'External-agent cleanup exceeded its deadline.'
  );
}

function assertExternalAgentParams(
  method: string,
  schema: Parameters<typeof Value.Check>[0],
  params: unknown
): void {
  if (Value.Check(schema, params)) return;
  const issue = Value.Errors(schema, params).First();
  throw new RuntimeToolArgumentError(
    `Runtime method "${method}" received an invalid external-agent payload${issue ? ` at "${issue.path || '/'}"` : ''}.`
  );
}
