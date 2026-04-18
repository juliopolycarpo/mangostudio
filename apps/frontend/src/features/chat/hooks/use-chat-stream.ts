import { useState, useCallback, useRef, useEffect } from 'react';
import type { ContextInfo, FallbackNotice } from '@/features/generation/types';

interface UseChatStreamOptions {
  currentChatId: string | null;
}

/** Manages SSE stream lifecycle: abort controller, generating state, context tracking. */
export function useChatStream({ currentChatId }: UseChatStreamOptions) {
  const [isGenerating, setIsGenerating] = useState(false);
  const [contextInfo, setContextInfo] = useState<ContextInfo | null>(null);
  const [fallbackNotice, setFallbackNotice] = useState<FallbackNotice | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Per-chat context info cache — survives chat switches
  const contextCacheRef = useRef<Map<string, ContextInfo>>(new Map());
  // Version counter makes contextCache reactive
  const [_cacheVersion, setCacheVersion] = useState(0);
  void _cacheVersion;
  // Ref to current chatId to avoid stale closures in seedContextInfo
  const currentChatIdRef = useRef(currentChatId);
  currentChatIdRef.current = currentChatId;

  // Restore cached context when the active chat changes. setState-in-effect is
  // intentional here: the per-chat cache is external state that must be hydrated
  // into React state when the active chat identity changes.
  useEffect(() => {
    if (currentChatId) {
      const cached = contextCacheRef.current.get(currentChatId);
      // eslint-disable-next-line @eslint-react/set-state-in-effect
      setContextInfo(cached ?? null);
    } else {
      // eslint-disable-next-line @eslint-react/set-state-in-effect
      setContextInfo(null);
    }
    // eslint-disable-next-line @eslint-react/set-state-in-effect
    setFallbackNotice(null);
  }, [currentChatId]);

  const handleStop = useCallback(() => {
    abortControllerRef.current?.abort();
  }, []);

  const setAbortController = useCallback((controller: AbortController | null) => {
    abortControllerRef.current = controller;
  }, []);

  const updateContextInfo = useCallback((chatId: string, info: ContextInfo) => {
    setContextInfo(info);
    contextCacheRef.current.set(chatId, info);
    setCacheVersion((v) => v + 1);
  }, []);

  const seedContextInfo = useCallback((chatId: string, info: ContextInfo) => {
    contextCacheRef.current.set(chatId, info);
    setCacheVersion((v) => v + 1);
    if (chatId === currentChatIdRef.current) {
      setContextInfo(info);
    }
  }, []);

  return {
    isGenerating,
    setIsGenerating,
    contextInfo,
    fallbackNotice,
    setFallbackNotice,
    handleStop,
    abortControllerRef,
    setAbortController,
    updateContextInfo,
    seedContextInfo,
    contextCache: contextCacheRef.current,
  };
}
