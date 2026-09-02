/**
 * In-memory registry of live terminal sessions.
 *
 * The runtime owns the PTY; this owns who may open one, the session records
 * `GET/POST/PATCH/DELETE /api/terminals` reads and writes, and the one-viewer
 * bookkeeping the socket route hands off to on attach/detach. Nothing here
 * survives a hub restart — an open session is tied to a live runtime
 * connection, and a restarted hub has none.
 */

import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import {
  TERMINAL_DEFAULT_COLS,
  TERMINAL_DEFAULT_ROWS,
  TERMINAL_SOCKET_CLOSE_CODES,
  type TerminalAvailability,
  type TerminalNotice,
  type TerminalOpenBody,
  type TerminalRenameBody,
  type TerminalSession,
} from '@mangostudio/shared/terminal';
import { getDb } from '../../../db/database';
import { getConfig as getApiConfig } from '../../../lib/config';
import { createDiagnosticLogger } from '../../../lib/logger';
import {
  getRuntimeClient as getRuntimeClientDefault,
  getRuntimeConnectionManager,
} from '../../../services/runtime-client/runtime-connection-manager';
import { getOwnedChat } from '../../chats/infrastructure/chat-repository';
import {
  TerminalChatNotFoundError,
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

export interface TerminalConfig {
  readonly enabled: boolean;
  readonly idleTimeoutMinutes: number;
  readonly maxSessionsPerUser: number;
  readonly scrollbackKib: number;
}

/**
 * The one thing a socket route hands the service so it can be told about
 * (and, on a runtime disconnect, tell) the browser socket currently attached.
 */
export interface TerminalSessionViewer {
  readonly pushNotice: (notice: TerminalNotice) => void;
  readonly close: (code: number, reason: string) => void;
}

export interface TerminalListFilter {
  readonly environmentId?: string;
  readonly chatId?: string;
}

export interface TerminalSessionServiceDeps {
  readonly getConfig: () => TerminalConfig;
  readonly getRuntimeClient: (
    userId: string,
    environmentId: string
  ) => Promise<TerminalRuntimeClient>;
  readonly isIdentityAttested: (userId: string, environmentId: string) => boolean;
  readonly resolveChat: (chatId: string, userId: string) => Promise<TerminalChatResolution>;
  readonly now: () => number;
  readonly randomId: () => string;
}

export interface TerminalSessionService {
  open(userId: string, body: TerminalOpenBody): Promise<TerminalSession>;
  list(userId: string, filter?: TerminalListFilter): TerminalSession[];
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
   * Releases the session's viewer slot. Returns false, and changes nothing,
   * when `viewer` is no longer the current one: a replaced socket closing late
   * must not detach the runtime session out from under the viewer that took
   * it over.
   */
  detachViewer(sessionId: string, viewer: TerminalSessionViewer): boolean;
  touchActivity(sessionId: string): void;
  /** Records a `terminal.output` exit frame, or an `attach` reply that arrived already exited. */
  recordExit(sessionId: string, exit: { exitCode: number | null; signal: string | null }): void;
  /** Records a client `resize` the runtime accepted. */
  recordResize(sessionId: string, cols: number, rows: number): void;
  /** Closes every session with no attached viewer, idle past the configured timeout. */
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
}

const DEFAULT_IDLE_REAPER_INTERVAL_MS = 60_000;

async function defaultResolveChat(chatId: string, userId: string): Promise<TerminalChatResolution> {
  const chat = await getOwnedChat(chatId, userId, getDb());
  if (!chat) return { ok: false };
  return { ok: true, chatId, workdir: chat.workdir };
}

function defaultDeps(): TerminalSessionServiceDeps {
  return {
    getConfig: () => getApiConfig().terminal,
    getRuntimeClient: (userId, environmentId) =>
      getRuntimeClientDefault(userId, environmentId) as Promise<TerminalRuntimeClient>,
    isIdentityAttested: (userId, environmentId) =>
      getRuntimeConnectionManager().isIdentityAttested(userId, environmentId),
    resolveChat: defaultResolveChat,
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
  const clientsWithCloseHandler = new WeakSet<TerminalRuntimeClient>();

  /** Sessions with a live shell. An exited one still listed is not a seat the cap protects. */
  function countRunning(userId: string): number {
    let count = 0;
    for (const entry of sessions.values()) {
      if (entry.ownerUserId === userId && entry.session.status === 'running') count += 1;
    }
    return count;
  }

  /** Ends every session on a client that just lost its runtime connection. */
  function handleRuntimeDisconnected(client: TerminalRuntimeClient): void {
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
    if (client.manifest.terminal === true) return;
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

  function reapIdleNow(): void {
    const cutoff = d.now() - d.getConfig().idleTimeoutMinutes * 60_000;
    for (const [id, entry] of sessions) {
      if (entry.viewer || entry.session.lastActivityAt > cutoff) continue;
      sessions.delete(id);
      void entry.client.terminal.close({ sessionId: id }).catch(() => undefined);
    }
  }

  return {
    async open(userId, body) {
      const config = d.getConfig();
      if (!config.enabled) throw new TerminalDisabledError();
      if (countRunning(userId) >= config.maxSessionsPerUser) {
        throw new TerminalLimitError(config.maxSessionsPerUser);
      }

      let cwd = body.cwd ?? null;
      let chatId: string | null = null;
      if (body.chatId) {
        const resolved = await d.resolveChat(body.chatId, userId);
        if (!resolved.ok) throw new TerminalChatNotFoundError(body.chatId);
        chatId = resolved.chatId;
        cwd ??= resolved.workdir;
      }

      const client = await requireClient(userId, body.environmentId);
      requireTerminalCapable(client, body.environmentId);
      requireIsolatedIfLocal(userId, body.environmentId);

      const sessionId = d.randomId();
      const cols = body.cols ?? TERMINAL_DEFAULT_COLS;
      const rows = body.rows ?? TERMINAL_DEFAULT_ROWS;
      const openResult = await client.terminal.open({
        sessionId,
        cols,
        rows,
        scrollbackBytes: config.scrollbackKib * 1024,
        ...(body.shell ? { shell: body.shell } : {}),
        ...(cwd ? { cwd } : {}),
        ...(chatId ? { env: { MANGOSTUDIO_CHAT_ID: chatId } } : {}),
      });

      const now = d.now();
      const session: TerminalSession = {
        id: sessionId,
        environmentId: body.environmentId,
        chatId,
        title: body.title ?? openResult.shell,
        shell: openResult.shell,
        cwd: openResult.cwd,
        cols,
        rows,
        status: 'running',
        attached: false,
        createdAt: now,
        lastActivityAt: now,
      };
      ensureCloseHandler(client);
      sessions.set(sessionId, { session, ownerUserId: userId, client, viewer: null });
      return session;
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
      sessions.delete(id);
      entry.viewer?.close(TERMINAL_SOCKET_CLOSE_CODES.GONE, 'Session closed');
      await entry.client.terminal.close({ sessionId: id }).catch((error: unknown) => {
        logger.warn('close_failed', {
          sessionId: id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    },

    async availability(userId, environmentId) {
      const config = d.getConfig();
      const base = {
        environmentId,
        openSessions: countRunning(userId),
        maxSessions: config.maxSessionsPerUser,
      };
      if (!config.enabled) return { ...base, available: false, reason: 'disabled', shells: [] };
      if (base.openSessions >= config.maxSessionsPerUser) {
        return { ...base, available: false, reason: 'limit', shells: [] };
      }

      let client: TerminalRuntimeClient;
      try {
        client = await d.getRuntimeClient(userId, environmentId);
      } catch {
        return { ...base, available: false, reason: 'disconnected', shells: [] };
      }
      if (client.manifest.terminal !== true) {
        return { ...base, available: false, reason: 'unavailable', shells: [] };
      }
      if (environmentId === LOCAL_ENVIRONMENT_ID && !d.isIdentityAttested(userId, environmentId)) {
        return { ...base, available: false, reason: 'not-isolated', shells: [] };
      }
      return { ...base, available: true, shells: [...client.manifest.shells] };
    },

    getForAttach(userId, sessionId) {
      const entry = sessions.get(sessionId);
      if (!entry || entry.ownerUserId !== userId) return null;
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
      const entries = [...sessions.values()];
      sessions.clear();
      await Promise.all(
        entries.map((entry) =>
          entry.client.terminal.close({ sessionId: entry.session.id }).catch(() => undefined)
        )
      );
    },
  };
}

export const terminalSessionService: TerminalSessionService = createTerminalSessionService();
