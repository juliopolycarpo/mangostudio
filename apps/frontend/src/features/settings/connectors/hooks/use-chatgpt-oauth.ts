import type { ChatGptOAuthStatus, StartChatGptOAuthResponse } from '@mangostudio/shared/connectors';
import { ERROR_CODES } from '@mangostudio/shared/errors';
import type { Messages } from '@mangostudio/shared/i18n';
import { useMutation } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { resolveApiErrorMessage } from '@/lib/utils';
import {
  ConnectorApiError,
  cancelChatGptOAuth,
  getChatGptOAuthStatus,
  startChatGptOAuth,
} from '../api';

const POLL_INTERVAL_MS = 2_000;

type OAuthPhase = 'idle' | 'starting' | 'waiting' | 'completed' | 'failed' | 'expired';

interface StartOAuthInput {
  name: string;
  connectorId?: string;
  popup: Window | null;
}

interface UseChatGptOAuthOptions {
  messages: Messages['settings']['connectors'];
  onSuccess: (connectorId: string | undefined) => void | Promise<void>;
}

function isPortBusyError(error: unknown): boolean {
  if (error instanceof ConnectorApiError && error.code === ERROR_CODES.PROVIDER_ERROR) {
    return error.message.includes('1455');
  }
  return error instanceof Error && error.message.includes('1455');
}

function mapErrorMessage(error: unknown, messages: Messages['settings']['connectors']): string {
  if (isPortBusyError(error)) return messages.chatgptPortBusyError;
  if (error instanceof ConnectorApiError && error.code === ERROR_CODES.CHATGPT_REAUTH_REQUIRED) {
    return messages.chatgptDeniedError;
  }
  return resolveApiErrorMessage(error, messages.chatgptFailedError);
}

function mapFailedStatus(
  status: ChatGptOAuthStatus,
  messages: Messages['settings']['connectors']
): string {
  if (status.error?.includes('1455')) return messages.chatgptPortBusyError;
  return messages.chatgptDeniedError;
}

export function useChatGptOAuth({ messages, onSuccess }: UseChatGptOAuthOptions) {
  const [phase, setPhase] = useState<OAuthPhase>('idle');
  const [session, setSession] = useState<StartChatGptOAuthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const onSuccessRef = useRef(onSuccess);
  const activeSessionIdRef = useRef<string | null>(null);
  const cancelOnCleanupRef = useRef(false);

  useEffect(() => {
    onSuccessRef.current = onSuccess;
  }, [onSuccess]);

  const startMutation = useMutation({
    mutationFn: startChatGptOAuth,
  });

  const cancelMutation = useMutation({
    mutationFn: cancelChatGptOAuth,
  });

  const reset = useCallback(() => {
    activeSessionIdRef.current = null;
    cancelOnCleanupRef.current = false;
    setSession(null);
    setPhase('idle');
    setError(null);
  }, []);

  const fail = useCallback((message: string, failedPhase: OAuthPhase = 'failed') => {
    activeSessionIdRef.current = null;
    cancelOnCleanupRef.current = false;
    setSession(null);
    setPhase(failedPhase);
    setError(message);
  }, []);

  const start = useCallback(
    async ({ name, connectorId, popup }: StartOAuthInput): Promise<void> => {
      const trimmedName = name.trim();
      if (!trimmedName) {
        fail(messages.chatgptNameRequired);
        popup?.close();
        return;
      }

      if (!popup) {
        fail(messages.chatgptPopupBlocked);
        return;
      }

      setPhase('starting');
      setError(null);

      try {
        const nextSession = await startMutation.mutateAsync({
          name: trimmedName,
          ...(connectorId ? { connectorId } : {}),
        });
        popup.location.href = nextSession.authorizeUrl;
        activeSessionIdRef.current = nextSession.sessionId;
        cancelOnCleanupRef.current = true;
        setSession(nextSession);
        setPhase('waiting');
      } catch (err) {
        popup.close();
        fail(mapErrorMessage(err, messages));
      }
    },
    [fail, messages, startMutation]
  );

  const cancel = useCallback(async (): Promise<void> => {
    const sessionId = activeSessionIdRef.current;
    if (!sessionId) {
      reset();
      return;
    }

    try {
      await cancelMutation.mutateAsync(sessionId);
      reset();
    } catch (err) {
      fail(mapErrorMessage(err, messages));
    }
  }, [cancelMutation, fail, messages, reset]);

  useEffect(() => {
    if (phase !== 'waiting' || !session) return;

    let stopped = false;
    let settled = false;
    let intervalId: number | undefined;

    const settleSuccess = async (status: ChatGptOAuthStatus) => {
      activeSessionIdRef.current = null;
      cancelOnCleanupRef.current = false;
      setPhase('completed');
      setError(null);
      await onSuccessRef.current(status.connectorId);
    };

    const poll = async () => {
      if (stopped || settled) return;
      if (Date.now() >= session.expiresAt) {
        settled = true;
        fail(messages.chatgptExpiredError, 'expired');
        return;
      }

      try {
        const status = await getChatGptOAuthStatus(session.sessionId);
        if (stopped || settled) return;
        if (status.status === 'completed') {
          settled = true;
          await settleSuccess(status);
          return;
        }
        if (status.status === 'failed') {
          settled = true;
          fail(mapFailedStatus(status, messages));
          return;
        }
        if (status.status === 'expired') {
          settled = true;
          fail(messages.chatgptExpiredError, 'expired');
        }
      } catch (err) {
        if (!stopped && !settled) fail(mapErrorMessage(err, messages));
      }
    };

    void poll();
    intervalId = window.setInterval(() => void poll(), POLL_INTERVAL_MS);

    return () => {
      stopped = true;
      if (intervalId !== undefined) window.clearInterval(intervalId);
    };
  }, [fail, messages, phase, session]);

  useEffect(() => {
    return () => {
      const sessionId = activeSessionIdRef.current;
      if (!cancelOnCleanupRef.current || !sessionId) return;
      void cancelChatGptOAuth(sessionId);
    };
  }, []);

  return {
    phase,
    session,
    error,
    isStarting: phase === 'starting',
    isWaiting: phase === 'waiting',
    isBusy: phase === 'starting' || phase === 'waiting',
    start,
    cancel,
    reset,
  };
}
