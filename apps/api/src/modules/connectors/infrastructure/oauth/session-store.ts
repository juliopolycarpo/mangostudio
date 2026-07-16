/**
 * In-memory TTL store for pending OAuth sign-in sessions.
 *
 * Sessions are keyed by id, owned by a user, and hold the loopback server for
 * their redirect. Only one pending session per user is allowed: OAuth loopback
 * ports are fixed by the provider's client registration, so a stale pending
 * session would hold the port until its TTL expires.
 */

import type { OAuthLoopbackServer } from './loopback-server';

type OAuthSessionStatus = 'pending' | 'completed' | 'failed' | 'expired';

export interface OAuthSessionBase {
  id: string;
  userId: string;
  status: OAuthSessionStatus;
  connectorId?: string;
  error?: string;
  errorCode?: string;
  /** Unix epoch ms when the session (and its loopback server) expires. */
  expiresAt: number;
  loopback: OAuthLoopbackServer;
}

export interface OAuthSessionStore<TSession extends OAuthSessionBase> {
  add(session: TSession): void;
  /** Returns the session only when it exists and is owned by the user. */
  get(userId: string, sessionId: string): TSession | undefined;
  /** Stops and removes any pending sessions owned by the user. */
  cancelPendingForUser(userId: string): void;
  /** Stops the session's loopback server and removes it from the store. */
  cancel(session: TSession): void;
  /** Transitions a pending session to failed; returns false when already settled. */
  markFailed(session: TSession, message: string, errorCode?: string): boolean;
  /** Transitions a pending session past its TTL to expired and frees its port. */
  expireIfDue(session: TSession, nowMs: number): void;
  /** Stops all loopback servers and clears the store (for tests). */
  reset(): void;
}

export function createOAuthSessionStore<
  TSession extends OAuthSessionBase,
>(): OAuthSessionStore<TSession> {
  const sessions = new Map<string, TSession>();

  return {
    add(session) {
      sessions.set(session.id, session);
    },

    get(userId, sessionId) {
      const session = sessions.get(sessionId);
      if (!session || session.userId !== userId) return undefined;
      return session;
    },

    cancelPendingForUser(userId) {
      for (const session of sessions.values()) {
        if (session.userId === userId && session.status === 'pending') {
          session.loopback.stop();
          sessions.delete(session.id);
        }
      }
    },

    cancel(session) {
      session.loopback.stop();
      sessions.delete(session.id);
    },

    markFailed(session, message, errorCode) {
      if (session.status !== 'pending') return false;
      session.status = 'failed';
      session.error = message;
      if (errorCode) session.errorCode = errorCode;
      return true;
    },

    expireIfDue(session, nowMs) {
      if (session.status !== 'pending' || nowMs <= session.expiresAt) return;
      session.status = 'expired';
      session.loopback.stop();
    },

    reset() {
      for (const session of sessions.values()) {
        session.loopback.stop();
      }
      sessions.clear();
    },
  };
}
