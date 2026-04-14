import { Brain, ChevronDown } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useI18n } from '@/hooks/use-i18n';
import { MarkdownContent } from '@/components/MarkdownContent';

interface ThinkingUiState {
  expanded: boolean;
  scrollTop: number;
  shouldAutoFollow: boolean;
}

const thinkingUiStateByMessage = new Map<string, ThinkingUiState>();

function isNearBottom(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= 24;
}

interface ThinkingBlockProps {
  messageId: string;
  text: string;
  isStreaming: boolean;
  segmentIndex?: number;
}

export function ThinkingBlock({
  messageId,
  text,
  isStreaming,
  segmentIndex = 0,
}: ThinkingBlockProps) {
  const { t } = useI18n();
  const initialUiStateRef = useRef<ThinkingUiState>(
    thinkingUiStateByMessage.get(messageId) ?? {
      expanded: isStreaming,
      scrollTop: 0,
      shouldAutoFollow: isStreaming,
    }
  );
  const [expanded, setExpanded] = useState(initialUiStateRef.current.expanded);
  const scrollRef = useRef<HTMLDivElement>(null);
  const uiStateRef = useRef(initialUiStateRef.current);
  const previousStreamingRef = useRef(isStreaming);

  const updateUiState = useCallback(
    (partial: Partial<ThinkingUiState>) => {
      uiStateRef.current = { ...uiStateRef.current, ...partial };
      thinkingUiStateByMessage.set(messageId, uiStateRef.current);
    },
    [messageId]
  );

  useEffect(() => {
    // Sync expansion with streaming lifecycle: auto-expand on stream start,
    // collapse on end. Not derivable from props because the initial state also
    // honors a session-scoped Map of user toggles.
    if (!previousStreamingRef.current && isStreaming) {
      // eslint-disable-next-line @eslint-react/set-state-in-effect
      setExpanded(true);
      updateUiState({ expanded: true, shouldAutoFollow: true });
    }
    if (previousStreamingRef.current && !isStreaming) {
      // eslint-disable-next-line @eslint-react/set-state-in-effect
      setExpanded(false);
      updateUiState({ expanded: false, shouldAutoFollow: false });
    }
    previousStreamingRef.current = isStreaming;
  }, [isStreaming, updateUiState]);

  useLayoutEffect(() => {
    if (!expanded || !scrollRef.current) return;
    const element = scrollRef.current;
    const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
    if (isStreaming && uiStateRef.current.shouldAutoFollow) {
      element.scrollTop = maxScrollTop;
      updateUiState({ scrollTop: element.scrollTop });
      return;
    }
    element.scrollTop = Math.min(uiStateRef.current.scrollTop, maxScrollTop);
  }, [expanded, isStreaming, text, updateUiState]);

  const handleToggle = () => {
    const nextExpanded = !expanded;
    setExpanded(nextExpanded);
    updateUiState({ expanded: nextExpanded });
  };

  const handleScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    updateUiState({
      scrollTop: element.scrollTop,
      shouldAutoFollow: isStreaming ? isNearBottom(element) : uiStateRef.current.shouldAutoFollow,
    });
  };

  return (
    <div className="mb-3">
      <button
        type="button"
        onClick={handleToggle}
        className="glass-surface flex items-center gap-2 text-xs text-on-surface-variant/70
                   py-1.5 px-3 rounded-full w-fit border border-outline-variant/20
                   hover:border-outline-variant/40 hover:text-on-surface-variant
                   transition-all duration-200 cursor-pointer"
      >
        <Brain size={11} className="text-primary/70" />
        <span className="tracking-wide">
          {isStreaming
            ? segmentIndex > 0
              ? t.thinking.streamingContinued
              : t.thinking.streaming
            : segmentIndex > 0
              ? t.thinking.labelContinued
              : t.thinking.label}
        </span>
        <ChevronDown
          size={11}
          className={`transition-transform duration-300 text-primary/50 ${expanded ? 'rotate-180' : ''}`}
        />
      </button>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            key="thinking-body"
            initial={{ opacity: 0, height: 0, y: -4 }}
            animate={{ opacity: 1, height: 'auto', y: 0 }}
            exit={{ opacity: 0, height: 0, y: -6 }}
            transition={{ duration: 0.22, ease: 'easeOut' }}
            className="glass-surface-subtle mt-1.5 rounded-xl border border-outline-variant/15 overflow-hidden"
          >
            <div
              ref={scrollRef}
              onScroll={handleScroll}
              className="p-4 max-h-48 overflow-y-auto app-scrollbar"
            >
              <div className="text-xs text-on-surface-variant/60 leading-relaxed markdown-content--thinking">
                <MarkdownContent
                  content={text}
                  isStreaming={isStreaming}
                  copyCodeLabel={t.chat.copyCode}
                  codeCopiedLabel={t.chat.codeCopied}
                />
                {isStreaming && (
                  <span className="inline-block w-0.5 h-[1em] bg-primary/40 ml-0.5 align-middle animate-blink" />
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
