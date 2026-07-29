import { API_KEY_HEADER } from '@mangostudio/shared/api-keys';
import { ERROR_CODES, type ErrorCode } from '@mangostudio/shared/errors';
import {
  parseGitTopic,
  REALTIME_CLOSE_CODES,
  type RealtimeClientMessage,
  RealtimeClientMessageSchema,
  type RealtimeErrorMessage,
  type RealtimeInvalidateEvent,
  RealtimeServerMessageSchema,
  SETTINGS_TOPIC,
} from '@mangostudio/shared/realtime';
import { Value } from '@sinclair/typebox/value';
import { Elysia } from 'elysia';
import { getAuth } from '../../../auth';
import { getDb } from '../../../db/database';
import { getConfig } from '../../../lib/config';
import { createDiagnosticLogger } from '../../../lib/logger';
import { getRealtimeBus, type RealtimeBus } from '../../../services/realtime/realtime-bus';
import { assertChatOwnership, ChatNotFoundError } from '../../chats/domain/chat-ownership';

const MAX_CONNECTIONS_PER_USER = 8;
const MAX_MESSAGES_PER_SECOND = 20;
const MAX_ACTIVE_TOPICS = 64;
const MESSAGE_RATE_WINDOW_MS = 1_000;

export const REALTIME_WEBSOCKET_OPTIONS = {
  idleTimeout: 60,
  maxPayloadLength: 16 * 1024,
  backpressureLimit: 64 * 1024,
  closeOnBackpressureLimit: true,
} as const;

type RejectionReason = 'unauthorized' | 'forbidden' | 'internal' | null;

interface RealtimeSocketState {
  userId: string | null;
  rejection: RejectionReason;
  topics: Set<string>;
  invalidMessageCount: number;
  rateWindowStartedAt: number;
  rateWindowMessageCount: number;
  connectionRegistered: boolean;
  unsubscribeBus: (() => void) | null;
  cleanedUp: boolean;
  /** Serializes async message handlers so topic/rate state cannot race across frames. */
  messageChain: Promise<void>;
}

interface RealtimeRouteDependencies {
  bus?: RealtimeBus;
  now?: () => number;
  resolveUserId?: (headers: Headers) => Promise<string | null>;
  ownsChat?: (chatId: string, userId: string) => Promise<boolean>;
  allowedOrigins?: readonly string[];
}

interface RealtimeSocket {
  id: string;
  send(
    message: RealtimeErrorMessage | RealtimeInvalidateEvent | { type: 'ready' | 'pong' }
  ): unknown;
  close(code?: number, reason?: string): unknown;
  cork(callback: () => void): unknown;
  data: {
    realtimeSocket: RealtimeSocketState;
  };
}

const logger = createDiagnosticLogger('realtime-ws');

function errorMessage(error: string, code: ErrorCode): RealtimeErrorMessage {
  return { type: 'error', error, code };
}

function sendAndClose(
  ws: RealtimeSocket,
  message: RealtimeErrorMessage,
  closeCode: number,
  reason: string
): void {
  ws.cork(() => {
    ws.send(message);
    ws.close(closeCode, reason);
  });
}

function configuredAllowedOrigins(): string[] {
  const config = getConfig();
  const origins = new Set(config.corsOrigins);
  try {
    origins.add(new URL(config.auth.url).origin);
  } catch {
    // Invalid auth URLs fail Better Auth initialization; keep route setup fail-soft.
  }
  return [...origins];
}

async function resolveCookieUserId(headers: Headers): Promise<string | null> {
  const session = await getAuth().api.getSession({ headers });
  return session?.user.id ?? null;
}

async function ownsChat(chatId: string, userId: string): Promise<boolean> {
  try {
    await assertChatOwnership(chatId, userId, getDb());
    return true;
  } catch (error) {
    if (error instanceof ChatNotFoundError) return false;
    throw error;
  }
}

export function createRealtimeRoutes(dependencies: RealtimeRouteDependencies = {}) {
  const bus = dependencies.bus ?? getRealtimeBus();
  const now = dependencies.now ?? Date.now;
  const resolveUserId = dependencies.resolveUserId ?? resolveCookieUserId;
  const verifyChatOwnership = dependencies.ownsChat ?? ownsChat;
  const allowedOrigins = new Set(dependencies.allowedOrigins ?? configuredAllowedOrigins());
  const connectionsByUser = new Map<string, Set<string>>();

  function cleanupConnection(state: RealtimeSocketState, socketId: string): void {
    if (state.cleanedUp) return;
    state.cleanedUp = true;
    state.unsubscribeBus?.();
    state.unsubscribeBus = null;

    if (!state.connectionRegistered || !state.userId) return;
    const connections = connectionsByUser.get(state.userId);
    connections?.delete(socketId);
    if (connections?.size === 0) connectionsByUser.delete(state.userId);
    state.connectionRegistered = false;
  }

  function failSocket(ws: RealtimeSocket, error: unknown): void {
    const state = ws.data.realtimeSocket;
    logger.error('handler_failed', {
      userId: state.userId,
      error: error instanceof Error ? error.message : String(error),
    });
    cleanupConnection(state, ws.id);
    sendAndClose(
      ws,
      errorMessage('Unexpected realtime server error', ERROR_CODES.INTERNAL),
      REALTIME_CLOSE_CODES.INTERNAL_ERROR,
      'Internal error'
    );
  }

  function registerConnection(ws: RealtimeSocket, userId: string): boolean {
    let connections = connectionsByUser.get(userId);
    if (!connections) {
      connections = new Set();
      connectionsByUser.set(userId, connections);
    }
    if (connections.size >= MAX_CONNECTIONS_PER_USER) return false;
    connections.add(ws.id);
    ws.data.realtimeSocket.connectionRegistered = true;
    return true;
  }

  function acceptsMessage(state: RealtimeSocketState): boolean {
    const currentTime = now();
    if (currentTime - state.rateWindowStartedAt >= MESSAGE_RATE_WINDOW_MS) {
      state.rateWindowStartedAt = currentTime;
      state.rateWindowMessageCount = 0;
    }
    state.rateWindowMessageCount += 1;
    return state.rateWindowMessageCount <= MAX_MESSAGES_PER_SECOND;
  }

  async function subscribe(ws: RealtimeSocket, message: RealtimeClientMessage): Promise<void> {
    if (message.type !== 'subscribe') return;
    const state = ws.data.realtimeSocket;
    if (!state.userId) return;
    const accepted = new Set<string>();

    for (const topic of message.topics) {
      if (state.topics.has(topic) || accepted.has(topic)) continue;
      if (topic === SETTINGS_TOPIC) {
        accepted.add(topic);
        continue;
      }

      const chatId = parseGitTopic(topic);
      if (!chatId) {
        ws.send(errorMessage('Unsupported realtime topic', ERROR_CODES.UNSUPPORTED));
        continue;
      }
      if (!(await verifyChatOwnership(chatId, state.userId))) {
        ws.send(errorMessage('Realtime topic is unavailable', ERROR_CODES.NOT_FOUND));
        continue;
      }
      accepted.add(topic);
    }

    // Message handlers are serialized per socket, so this check sees committed
    // topics from prior frames and cannot race another subscribe commit.
    if (state.topics.size + accepted.size > MAX_ACTIVE_TOPICS) {
      ws.send(errorMessage('Realtime subscription limit exceeded', ERROR_CODES.RATE_LIMITED));
      return;
    }
    for (const topic of accepted) state.topics.add(topic);
  }

  return new Elysia({ name: 'realtime-routes' })
    .derive(async ({ request }) => {
      const origin = request.headers.get('origin');
      let rejection: RejectionReason = origin && !allowedOrigins.has(origin) ? 'forbidden' : null;
      let userId: string | null = null;

      if (!rejection && request.headers.has(API_KEY_HEADER)) {
        rejection = 'unauthorized';
      } else if (!rejection) {
        try {
          userId = await resolveUserId(request.headers);
          if (!userId) rejection = 'unauthorized';
        } catch (error) {
          logger.error('session_resolution_failed', {
            error: error instanceof Error ? error.message : String(error),
          });
          rejection = 'internal';
        }
      }

      return {
        realtimeSocket: {
          userId,
          rejection,
          topics: new Set<string>(),
          invalidMessageCount: 0,
          rateWindowStartedAt: now(),
          rateWindowMessageCount: 0,
          connectionRegistered: false,
          unsubscribeBus: null,
          cleanedUp: false,
          messageChain: Promise.resolve(),
        } satisfies RealtimeSocketState,
      };
    })
    .ws('/ws', {
      response: RealtimeServerMessageSchema,
      open(ws) {
        const socket = ws as unknown as RealtimeSocket;
        const state = socket.data.realtimeSocket;

        if (state.rejection === 'forbidden') {
          sendAndClose(
            socket,
            errorMessage('Origin is not allowed', ERROR_CODES.PERMISSION_DENIED),
            REALTIME_CLOSE_CODES.FORBIDDEN,
            'Forbidden'
          );
          return;
        }
        if (state.rejection === 'internal') {
          failSocket(socket, new Error('Session resolution failed'));
          return;
        }
        if (state.rejection === 'unauthorized' || !state.userId) {
          sendAndClose(
            socket,
            errorMessage('Unauthorized', ERROR_CODES.UNAUTHORIZED),
            REALTIME_CLOSE_CODES.UNAUTHORIZED,
            'Unauthorized'
          );
          return;
        }
        if (!registerConnection(socket, state.userId)) {
          sendAndClose(
            socket,
            errorMessage('Realtime connection limit exceeded', ERROR_CODES.RATE_LIMITED),
            REALTIME_CLOSE_CODES.RATE_LIMITED,
            'Rate limited'
          );
          return;
        }

        try {
          state.unsubscribeBus = bus.subscribe(state.userId, (event) => {
            if (!state.topics.has(event.topic)) return;
            try {
              socket.send(event);
            } catch (error) {
              failSocket(socket, error);
            }
          });
          socket.send({ type: 'ready' });
        } catch (error) {
          failSocket(socket, error);
        }
      },
      async message(ws, incomingMessage) {
        const socket = ws as unknown as RealtimeSocket;
        const state = socket.data.realtimeSocket;
        if (state.cleanedUp || state.rejection || !state.userId) return;

        const run = async (): Promise<void> => {
          if (state.cleanedUp || state.rejection || !state.userId) return;

          try {
            if (!acceptsMessage(state)) {
              cleanupConnection(state, socket.id);
              sendAndClose(
                socket,
                errorMessage('Realtime message rate exceeded', ERROR_CODES.RATE_LIMITED),
                REALTIME_CLOSE_CODES.RATE_LIMITED,
                'Rate limited'
              );
              return;
            }

            if (!Value.Check(RealtimeClientMessageSchema, incomingMessage)) {
              state.invalidMessageCount += 1;
              const validationError = errorMessage(
                'Invalid realtime message',
                ERROR_CODES.VALIDATION
              );
              if (state.invalidMessageCount >= 2) {
                cleanupConnection(state, socket.id);
                sendAndClose(
                  socket,
                  validationError,
                  REALTIME_CLOSE_CODES.INVALID_MESSAGE,
                  'Invalid message'
                );
              } else {
                socket.send(validationError);
              }
              return;
            }

            const message = incomingMessage as RealtimeClientMessage;
            if (message.type === 'ping') {
              socket.send({ type: 'pong' });
              return;
            }
            if (message.type === 'unsubscribe') {
              for (const topic of message.topics) {
                if (topic === SETTINGS_TOPIC || parseGitTopic(topic)) {
                  state.topics.delete(topic);
                } else {
                  socket.send(errorMessage('Unsupported realtime topic', ERROR_CODES.UNSUPPORTED));
                }
              }
              return;
            }
            await subscribe(socket, message);
          } catch (error) {
            failSocket(socket, error);
          }
        };

        // Keep the chain alive after failures so later frames still serialize.
        const queued = state.messageChain.then(run, run);
        state.messageChain = queued.then(
          () => undefined,
          () => undefined
        );
        await queued;
      },
      close(ws) {
        const socket = ws as unknown as RealtimeSocket;
        cleanupConnection(socket.data.realtimeSocket, socket.id);
      },
    });
}

export const realtimeRoutes = createRealtimeRoutes();
