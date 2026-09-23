/**
 * In-memory registry of live terminal sessions.
 *
 * The runtime owns the PTY; this owns who may open one, the session records
 * `GET/POST/PATCH/DELETE /api/terminals` reads and writes, and the one-viewer
 * bookkeeping the socket route hands off to on attach/detach. Nothing here
 * survives a hub restart — an open session is tied to a live runtime
 * connection, and a restarted hub has none.
 */

import { RESERVED_ERROR_CODES, RemoteError } from '@mangostudio/protocol';
import { LOCAL_ENVIRONMENT_ID, type ToolchainSelection } from '@mangostudio/shared/environments';
import { RuntimeConsentDeniedError } from '@mangostudio/shared/runtime-contract';
import {
  TERMINAL_DEFAULT_COLS,
  TERMINAL_DEFAULT_ROWS,
  TERMINAL_SOCKET_CLOSE_CODES,
  type TerminalAvailability,
  type TerminalExit,
  type TerminalListQuery,
  type TerminalNotice,
  type TerminalOpenBody,
  type TerminalRefusalReason,
  type TerminalRenameBody,
  type TerminalSession,
} from '@mangostudio/shared/terminal';
import { getDb } from '../../../db/database';
import { getConfig as getApiConfig, type MangoConfig } from '../../../lib/config';
import { createDiagnosticLogger } from '../../../lib/logger';
import {
  getRuntimeClient as getRuntimeClientDefault,
  getRuntimeConnectionManager,
} from '../../../services/runtime-client/runtime-connection-manager';
import { ToolExecutionTimedOutError } from '../../../services/tools/execution-timeout';
import { ChatNotFoundError } from '../../chats/domain/chat-ownership';
import { getOwnedChat } from '../../chats/infrastructure/chat-repository';
import {
  resolveToolchainParams,
  toolchainService,
} from '../../environments/application/toolchain-service';
import {
  TerminalDisabledError,
  TerminalLimitError,
  TerminalNotIsolatedError,
  TerminalSessionNotFoundError,
  TerminalUnavailableError,
} from '../domain/terminal-errors';
import type { TerminalRuntimeClient } from '../domain/terminal-runtime-client';

const logger = createDiagnosticLogger('terminals');

/**
 * Resolved once a `chatId` is given; `workdir` may still be null.
 *
 * `ok: false` never distinguishes a missing chat from one owned by another
 * user — that distinction is exactly the oracle an ownership check exists to
 * deny. See `TerminalSessionService.getForAttach`'s doc comment for the same
 * invariant elsewhere in this module.
 */
export type TerminalChatResolution =
  | { readonly ok: true; readonly chatId: string; readonly workdir: string | null }
  | { readonly ok: false };

/** The `[terminal]` block of the hub config, whose parsing owns these bounds. */
export type TerminalConfig = MangoConfig['terminal'];

/**
 * The one thing a socket route hands the service so it can be told about
 * (and, on a runtime disconnect, tell) the browser socket currently attached.
 */
export interface TerminalSessionViewer {
  readonly pushNotice: (notice: TerminalNotice) => void;
  readonly close: (code: number, reason: string) => void;
}

export interface TerminalSessionServiceDeps {
  readonly getConfig: () => TerminalConfig;
  readonly getRuntimeClient: (
    userId: string,
    environmentId: string
  ) => Promise<TerminalRuntimeClient>;
  readonly isIdentityAttested: (userId: string, environmentId: string) => boolean;
  readonly resolveChat: (chatId: string, userId: string) => Promise<TerminalChatResolution>;
  readonly resolveToolchain: (userId: string, environmentId: string) => Promise<ToolchainSelection>;
  readonly now: () => number;
  readonly randomId: () => string;
}

export interface TerminalSessionService {
  open(userId: string, body: TerminalOpenBody, signal?: AbortSignal): Promise<TerminalSession>;
  /** Refresh detached status from runtime.list. // Usage: await service.reconcile(userId) */
  reconcile(userId: string): Promise<void>;
  /** Ends sessions after terminal consent is withdrawn. // Usage: service.revokeScope(userId, envId) */
  revokeScope(userId: string, environmentId: string): void;
  list(userId: string, filter?: TerminalListQuery): TerminalSession[];
  rename(userId: string, id: string, body: TerminalRenameBody): TerminalSession;
  close(userId: string, id: string): Promise<void>;
  availability(userId: string, environmentId: string): Promise<TerminalAvailability>;
  /** Ownership-checked lookup for the socket route; never distinguishes missing from foreign. */
  getForAttach(
    userId: string,
    sessionId: string
  ): { readonly session: TerminalSession; readonly client: TerminalRuntimeClient } | null;
  /** Registers the current viewer, returning the one it replaced, if any. */
  attachViewer(
    sessionId: string,
    viewer: TerminalSessionViewer
  ): { readonly replaced: TerminalSessionViewer | null };
  /**
   * Whether `viewer` still holds the session. The socket route reads this
   * across an await to decide whether it may still speak for the session: a
   * takeover registers synchronously, so this answers before the replaced
   * socket's `close` handler has fired.
   */
  isCurrentViewer(sessionId: string, viewer: TerminalSessionViewer): boolean;
  /**
   * Releases the session's viewer slot. Returns false, and changes nothing,
   * when `viewer` is no longer the current one: a replaced socket closing late
   * must not detach the runtime session out from under the viewer that took
   * it over.
   */
  detachViewer(sessionId: string, viewer: TerminalSessionViewer): boolean;
  touchActivity(sessionId: string): void;
  /** Records a `terminal.output` exit frame, or an `attach` reply that arrived already exited. */
  recordExit(sessionId: string, exit: TerminalExit): void;
  /** Records a client `resize` the runtime accepted. */
  recordResize(sessionId: string, cols: number, rows: number): void;
  /** Closes idle detached sessions and retries revoked cleanup regardless of idle age. */
  reapIdle(): void;
  /** Starts the unref'd idle-reaper interval; returns a function that stops it. */
  startIdleReaper(intervalMs?: number): () => void;
  /** Best-effort `terminal.close` for every session, for hub shutdown. */
  closeAll(): Promise<void>;
}

interface TerminalSessionEntry {
  session: TerminalSession;
  ownerUserId: string;
  client: TerminalRuntimeClient;
  viewer: TerminalSessionViewer | null;
  cleanupPending: boolean;
}

interface TerminalReservation {
  readonly ownerUserId: string;
  readonly environmentId: string;
  client: TerminalRuntimeClient | null;
  canceled: boolean;
  scopeEnded: 'runtime-disconnected' | 'revoked' | 'shutdown' | null;
  openSent: boolean;
}

const DEFAULT_IDLE_REAPER_INTERVAL_MS = 60_000;
const TERMINAL_LIST_TIMEOUT_MS = 5_000;
const TERMINAL_OPEN_TIMEOUT_MS = 30_000;
const TERMINAL_CLOSE_TIMEOUT_MS = 10_000;

async function defaultResolveChat(chatId: string, userId: string): Promise<TerminalChatResolution> {
  const chat = await getOwnedChat(chatId, userId, getDb());
  if (!chat) return { ok: false };
  return { ok: true, chatId, workdir: chat.workdir };
}

function defaultDeps(): TerminalSessionServiceDeps {
  return {
    getConfig: () => getApiConfig().terminal,
    getRuntimeClient: (userId, environmentId) => getRuntimeClientDefault(userId, environmentId),
    isIdentityAttested: (userId, environmentId) =>
      getRuntimeConnectionManager().isIdentityAttested(userId, environmentId),
    resolveChat: defaultResolveChat,
    resolveToolchain: (userId, environmentId) => toolchainService.resolve(userId, environmentId),
    now: Date.now,
    randomId: () => crypto.randomUUID(),
  };
}

/** Build the service. // Usage: createTerminalSessionService().open(userId, body) */
export function createTerminalSessionService(
  deps: Partial<TerminalSessionServiceDeps> = {}
): TerminalSessionService {
  const d = { ...defaultDeps(), ...deps };
  const sessions = new Map<string, TerminalSessionEntry>();
  const reservations = new Set<TerminalReservation>();
  const reaping = new Set<string>();
  const clientsWithCloseHandler = new WeakSet<TerminalRuntimeClient>();
  let shuttingDown = false;

  /** Sessions with a live shell. An exited one still listed is not a seat the cap protects. */
  function countRunning(userId: string): number {
    let count = 0;
    for (const entry of sessions.values()) {
      if (entry.ownerUserId === userId && entry.session.status === 'running') count += 1;
    }
    for (const reservation of reservations) {
      if (reservation.ownerUserId === userId) count += 1;
    }
    return count;
  }

  function cancelReservation(
    reservation: TerminalReservation,
    reason: 'runtime-disconnected' | 'shutdown'
  ): void {
    reservation.canceled = true;
    reservation.scopeEnded = reason;
    reservations.delete(reservation);
  }

  /** A runtime snapshot can retire only detached records present when the request began. */
  async function reconcileDetached(userId: string): Promise<void> {
    const byClient = new Map<TerminalRuntimeClient, Array<[string, TerminalSessionEntry]>>();
    for (const [id, entry] of sessions) {
      if (entry.ownerUserId !== userId || entry.viewer || entry.session.status !== 'running') {
        continue;
      }
      const entries = byClient.get(entry.client) ?? [];
      entries.push([id, entry]);
      byClient.set(entry.client, entries);
    }
    await Promise.all(
      [...byClient].map(async ([client, entries]) => {
        let listed: Awaited<ReturnType<TerminalRuntimeClient['terminal']['list']>>;
        try {
          listed = await client.terminal.list({ timeoutMs: TERMINAL_LIST_TIMEOUT_MS });
        } catch (error) {
          logger.warn('reconcile_failed', {
            error: error instanceof Error ? error.message : String(error),
          });
          return;
        }
        const actual = new Map(listed.sessions.map((session) => [session.sessionId, session]));
        for (const [id, entry] of entries) {
          if (sessions.get(id) !== entry || entry.viewer || entry.session.status !== 'running') {
            continue;
          }
          const runtimeSession = actual.get(id);
          if (runtimeSession?.status === 'running') continue;
          entry.session.status = 'exited';
          entry.session.exit = {
            exitCode: runtimeSession?.exitCode ?? null,
            signal: runtimeSession?.signal ?? null,
          };
          entry.session.lastActivityAt = d.now();
        }
      })
    );
  }

  /** Ends every session on a client that just lost its runtime connection. */
  function handleRuntimeDisconnected(client: TerminalRuntimeClient): void {
    for (const reservation of reservations) {
      if (reservation.client === client) cancelReservation(reservation, 'runtime-disconnected');
    }
    for (const [id, entry] of sessions) {
      if (entry.client !== client) continue;
      entry.session.status = 'exited';
      entry.session.exit = { exitCode: null, signal: null };
      entry.session.lastActivityAt = d.now();
      entry.viewer?.pushNotice({ kind: 'runtime_disconnected' });
      entry.viewer?.close(TERMINAL_SOCKET_CLOSE_CODES.GONE, 'Runtime disconnected');
      sessions.delete(id);
    }
  }

  function ensureCloseHandler(client: TerminalRuntimeClient): void {
    if (clientsWithCloseHandler.has(client)) return;
    clientsWithCloseHandler.add(client);
    client.onClose(() => handleRuntimeDisconnected(client));
  }

  /** A disconnected environment and one this hub cannot reach both read the same. */
  async function requireClient(
    userId: string,
    environmentId: string
  ): Promise<TerminalRuntimeClient> {
    try {
      return await d.getRuntimeClient(userId, environmentId);
    } catch (error) {
      logger.warn('runtime_unavailable', {
        environmentId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new TerminalUnavailableError(
        'disconnected',
        `Environment "${environmentId}" has no live runtime connection right now.`
      );
    }
  }

  function requireTerminalCapable(client: TerminalRuntimeClient, environmentId: string): void {
    if (client.manifest.terminal === true && client.manifest.features.shell !== false) return;
    throw new TerminalUnavailableError(
      'unavailable',
      `Environment "${environmentId}" does not offer a terminal.`
    );
  }

  function requireIsolatedIfLocal(userId: string, environmentId: string): void {
    if (environmentId !== LOCAL_ENVIRONMENT_ID) return;
    if (d.isIdentityAttested(userId, environmentId)) return;
    throw new TerminalNotIsolatedError();
  }

  function closeTrackedSession(
    id: string,
    entry: TerminalSessionEntry,
    reason: 'idle' | 'revoked'
  ): void {
    if (reaping.has(id)) return;
    reaping.add(id);
    void (async () => {
      try {
        await entry.client.terminal.close(
          { sessionId: id },
          { timeoutMs: TERMINAL_CLOSE_TIMEOUT_MS }
        );
        if (sessions.get(id) !== entry) return;
        if (entry.viewer) {
          entry.session.status = 'exited';
          entry.session.exit = { exitCode: null, signal: null };
          entry.session.lastActivityAt = d.now();
          entry.viewer.close(
            TERMINAL_SOCKET_CLOSE_CODES.GONE,
            reason === 'revoked' ? 'Terminal access revoked' : 'Session closed while idle'
          );
        }
        sessions.delete(id);
      } catch (error) {
        logger.warn(reason === 'revoked' ? 'revoked_close_failed' : 'idle_close_failed', {
          sessionId: id,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        reaping.delete(id);
      }
    })();
  }

  function reapIdleNow(): void {
    const cutoff = d.now() - d.getConfig().idleTimeoutMinutes * 60_000;
    for (const [id, entry] of sessions) {
      if (reaping.has(id)) continue;
      if (!entry.cleanupPending && (entry.viewer || entry.session.lastActivityAt > cutoff)) {
        continue;
      }
      closeTrackedSession(id, entry, 'idle');
    }
  }

  return {
    async open(userId, body, signal) {
      const config = d.getConfig();
      if (!config.enabled) throw new TerminalDisabledError();
      if (shuttingDown) {
        throw new TerminalUnavailableError('disconnected', 'Terminal service is shutting down.');
      }
      if (countRunning(userId) >= config.maxSessionsPerUser) await reconcileDetached(userId);
      if (shuttingDown) {
        throw new TerminalUnavailableError('disconnected', 'Terminal service is shutting down.');
      }
      if (countRunning(userId) >= config.maxSessionsPerUser) {
        throw new TerminalLimitError(config.maxSessionsPerUser);
      }

      // Reserve synchronously after the last capacity check. Every await below
      // holds this seat until a registered session replaces it or open fails.
      const reservation: TerminalReservation = {
        ownerUserId: userId,
        environmentId: body.environmentId,
        client: null,
        canceled: false,
        scopeEnded: null,
        openSent: false,
      };
      reservations.add(reservation);
      // Before terminal.open is sent, abort can free the seat immediately.
      // Afterward it stays held until a late PTY is closed.
      const onAbort = (): void => {
        reservation.canceled = true;
        if (!reservation.openSent) reservations.delete(reservation);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
      const requireReservation = (): void => {
        if (!reservation.canceled) return;
        if (signal?.aborted) throw new DOMException('Terminal open canceled.', 'AbortError');
        if (shuttingDown) {
          throw new TerminalUnavailableError('disconnected', 'Terminal service is shutting down.');
        }
        throw new TerminalUnavailableError(
          'disconnected',
          `Environment "${body.environmentId}" disconnected before the terminal opened.`
        );
      };

      try {
        requireReservation();

        let cwd = body.cwd ?? null;
        let chatId: string | null = null;
        if (body.chatId) {
          const resolved = await d.resolveChat(body.chatId, userId);
          requireReservation();
          if (!resolved.ok) throw new ChatNotFoundError(body.chatId);
          chatId = resolved.chatId;
          cwd ??= resolved.workdir;
        }

        const client = await requireClient(userId, body.environmentId);
        requireReservation();
        reservation.client = client;
        ensureCloseHandler(client);
        requireTerminalCapable(client, body.environmentId);
        requireIsolatedIfLocal(userId, body.environmentId);

        const sessionId = d.randomId();
        const cols = body.cols ?? TERMINAL_DEFAULT_COLS;
        const rows = body.rows ?? TERMINAL_DEFAULT_ROWS;
        const toolchain = await resolveToolchainParams(client.manifest, () =>
          d.resolveToolchain(userId, body.environmentId)
        );
        requireReservation();
        const registerSession = (
          shell: TerminalSession['shell'],
          sessionCwd: string,
          status: TerminalSession['status'] = 'running'
        ) => {
          const now = d.now();
          const session: TerminalSession = {
            id: sessionId,
            environmentId: body.environmentId,
            chatId,
            title: body.title ?? shell,
            shell,
            cwd: sessionCwd,
            cols,
            rows,
            status,
            attached: false,
            createdAt: now,
            lastActivityAt: now,
            ...(status === 'exited' ? { exit: { exitCode: null, signal: null } } : {}),
          };
          reservations.delete(reservation);
          sessions.set(sessionId, {
            session,
            ownerUserId: userId,
            client,
            viewer: null,
            cleanupPending: status === 'exited',
          });
          return session;
        };
        const closeUnclaimed = async (): Promise<boolean> => {
          try {
            await client.terminal.close({ sessionId }, { timeoutMs: TERMINAL_CLOSE_TIMEOUT_MS });
            return true;
          } catch (error) {
            logger.warn('late_open_close_failed', {
              sessionId,
              error: error instanceof Error ? error.message : String(error),
            });
            return false;
          }
        };
        const retainUnclaimed = (shell: TerminalSession['shell'], sessionCwd: string): void => {
          if (reservation.scopeEnded === 'revoked') {
            // Consent withdrawal cannot restore a cap seat, but an accepted or
            // ambiguous PTY still needs a handle for a later cleanup retry.
            registerSession(shell, sessionCwd, 'exited');
          } else if (!reservation.scopeEnded) {
            registerSession(shell, sessionCwd);
          }
        };
        reservation.openSent = true;
        let openResult: Awaited<ReturnType<TerminalRuntimeClient['terminal']['open']>>;
        try {
          openResult = await client.terminal.open(
            {
              sessionId,
              cols,
              rows,
              scrollbackBytes: config.scrollbackKib * 1024,
              ...(body.shell ? { shell: body.shell } : {}),
              ...(cwd ? { cwd } : {}),
              ...(chatId ? { env: { MANGOSTUDIO_CHAT_ID: chatId } } : {}),
              ...toolchain,
            },
            { timeoutMs: TERMINAL_OPEN_TIMEOUT_MS }
          );
        } catch (error) {
          // A timeout or lost response cannot prove that the runtime refused
          // the open. Close by id; retain an ambiguous live PTY if cleanup fails.
          const consentDenied =
            error instanceof RuntimeConsentDeniedError ||
            (error instanceof RemoteError && error.code === RESERVED_ERROR_CODES.DENIED);
          if (!(await closeUnclaimed()) && !consentDenied) {
            retainUnclaimed(
              body.shell ?? client.manifest.shells[0] ?? 'bash',
              cwd ?? client.manifest.homeDir
            );
          }
          if (reservation.canceled) requireReservation();
          if (consentDenied) {
            throw new TerminalUnavailableError(
              'unavailable',
              `Environment "${body.environmentId}" no longer grants terminal access.`
            );
          }
          if (
            error instanceof ToolExecutionTimedOutError ||
            (error instanceof RemoteError && error.code === RESERVED_ERROR_CODES.UNAVAILABLE)
          ) {
            throw new TerminalUnavailableError(
              'disconnected',
              `Environment "${body.environmentId}" did not complete the terminal open.`
            );
          }
          throw error;
        }
        if (reservation.canceled) {
          if (!(await closeUnclaimed())) retainUnclaimed(openResult.shell, openResult.cwd);
          requireReservation();
        }
        return registerSession(openResult.shell, openResult.cwd);
      } finally {
        signal?.removeEventListener('abort', onAbort);
        reservations.delete(reservation);
      }
    },

    reconcile: reconcileDetached,

    revokeScope(userId, environmentId) {
      for (const reservation of reservations) {
        if (reservation.ownerUserId !== userId || reservation.environmentId !== environmentId) {
          continue;
        }
        reservation.canceled = true;
        reservation.scopeEnded = 'revoked';
        if (!reservation.openSent) reservations.delete(reservation);
      }
      for (const [id, entry] of sessions) {
        if (entry.ownerUserId !== userId || entry.session.environmentId !== environmentId) {
          continue;
        }
        entry.cleanupPending = true;
        entry.session.status = 'exited';
        entry.session.exit = { exitCode: null, signal: null };
        entry.session.lastActivityAt = d.now();
        entry.viewer?.close(TERMINAL_SOCKET_CLOSE_CODES.GONE, 'Terminal access revoked');
        closeTrackedSession(id, entry, 'revoked');
      }
    },

    list(userId, filter = {}) {
      const results: TerminalSession[] = [];
      for (const entry of sessions.values()) {
        if (entry.ownerUserId !== userId) continue;
        if (filter.environmentId && entry.session.environmentId !== filter.environmentId) continue;
        if (filter.chatId && entry.session.chatId !== filter.chatId) continue;
        results.push(entry.session);
      }
      return results;
    },

    rename(userId, id, body) {
      const entry = sessions.get(id);
      if (!entry || entry.ownerUserId !== userId) throw new TerminalSessionNotFoundError(id);
      entry.session.title = body.title;
      return entry.session;
    },

    async close(userId, id) {
      const entry = sessions.get(id);
      if (!entry || entry.ownerUserId !== userId) throw new TerminalSessionNotFoundError(id);
      try {
        await entry.client.terminal.close(
          { sessionId: id },
          { timeoutMs: TERMINAL_CLOSE_TIMEOUT_MS }
        );
      } catch (error) {
        logger.warn('close_failed', {
          sessionId: id,
          error: error instanceof Error ? error.message : String(error),
        });
        throw new TerminalUnavailableError(
          'disconnected',
          `Terminal "${id}" could not be closed on its runtime.`
        );
      }
      if (sessions.get(id) === entry) sessions.delete(id);
      entry.viewer?.close(TERMINAL_SOCKET_CLOSE_CODES.GONE, 'Session closed');
    },

    async availability(userId, environmentId) {
      const config = d.getConfig();
      await reconcileDetached(userId);
      const base = {
        environmentId,
        openSessions: countRunning(userId),
        maxSessions: config.maxSessionsPerUser,
      };
      // `shells` is empty on every refusal (`TerminalAvailabilitySchema`), so the
      // refusals share one constructor rather than restating that invariant five times.
      const refuse = (reason: TerminalRefusalReason): TerminalAvailability => ({
        ...base,
        available: false,
        reason,
        shells: [],
      });

      if (!config.enabled) return refuse('disabled');
      if (base.openSessions >= config.maxSessionsPerUser) return refuse('limit');

      let client: TerminalRuntimeClient;
      try {
        client = await d.getRuntimeClient(userId, environmentId);
      } catch {
        return refuse('disconnected');
      }
      if (client.manifest.terminal !== true || client.manifest.features.shell === false) {
        return refuse('unavailable');
      }
      if (environmentId === LOCAL_ENVIRONMENT_ID && !d.isIdentityAttested(userId, environmentId)) {
        return refuse('not-isolated');
      }
      return { ...base, available: true, shells: [...client.manifest.shells] };
    },

    getForAttach(userId, sessionId) {
      const entry = sessions.get(sessionId);
      if (
        !entry ||
        entry.ownerUserId !== userId ||
        entry.cleanupPending ||
        reaping.has(sessionId)
      ) {
        return null;
      }
      return { session: entry.session, client: entry.client };
    },

    attachViewer(sessionId, viewer) {
      const entry = sessions.get(sessionId);
      if (!entry) return { replaced: null };
      const replaced = entry.viewer;
      entry.viewer = viewer;
      entry.session.attached = true;
      entry.session.lastActivityAt = d.now();
      return { replaced };
    },

    isCurrentViewer(sessionId, viewer) {
      return sessions.get(sessionId)?.viewer === viewer;
    },

    detachViewer(sessionId, viewer) {
      const entry = sessions.get(sessionId);
      if (!entry || entry.viewer !== viewer) return false;
      entry.viewer = null;
      entry.session.attached = false;
      entry.session.lastActivityAt = d.now();
      return true;
    },

    touchActivity(sessionId) {
      const entry = sessions.get(sessionId);
      if (entry) entry.session.lastActivityAt = d.now();
    },

    recordExit(sessionId, exit) {
      const entry = sessions.get(sessionId);
      if (!entry) return;
      entry.session.status = 'exited';
      entry.session.exit = exit;
      entry.session.lastActivityAt = d.now();
    },

    recordResize(sessionId, cols, rows) {
      const entry = sessions.get(sessionId);
      if (!entry) return;
      entry.session.cols = cols;
      entry.session.rows = rows;
      entry.session.lastActivityAt = d.now();
    },

    reapIdle: reapIdleNow,

    startIdleReaper(intervalMs = DEFAULT_IDLE_REAPER_INTERVAL_MS) {
      const timer = setInterval(reapIdleNow, intervalMs);
      timer.unref?.();
      return () => clearInterval(timer);
    },

    async closeAll() {
      shuttingDown = true;
      for (const reservation of reservations) cancelReservation(reservation, 'shutdown');
      const entries = [...sessions.values()];
      sessions.clear();
      await Promise.all(
        entries.map((entry) =>
          entry.client.terminal
            .close({ sessionId: entry.session.id }, { timeoutMs: TERMINAL_CLOSE_TIMEOUT_MS })
            .catch(() => undefined)
        )
      );
    },
  };
}

export const terminalSessionService: TerminalSessionService = createTerminalSessionService();
