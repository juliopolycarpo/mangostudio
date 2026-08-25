import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { MarkdownContent } from '@/components/MarkdownContent';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { TimelineDisclosure } from './TimelineDisclosure';
import { TimelineItem } from './TimelineItem';
import { TimelineRow } from './TimelineRow';

interface ThinkingUiState {
  expanded: boolean;
  scrollTop: number;
  shouldAutoFollow: boolean;
  /** Monotonic timestamp of the first streaming frame, while one is running. */
  startedAt?: number;
  /** How long the block streamed for, once it stopped. */
  durationMs?: number;
}

const thinkingUiStateByMessage = new Map<string, ThinkingUiState>();

/**
 * Clears the per-block thinking state between tests.
 *
 * The map is module-level so a virtualized row keeps its expansion and its
 * measured duration across unmount, which also means it outlives `cleanup()`.
 *
 * // Usage: resetThinkingBlockStateForTest()
 */
export function resetThinkingBlockStateForTest(): void {
  thinkingUiStateByMessage.clear();
}

function isNearBottom(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= 24;
}

/** Rounds an elapsed thought to whole seconds, floored at one. */
function formatThinkingDuration(durationMs: number): string {
  return `${Math.max(1, Math.round(durationMs / 1000))}s`;
}

interface ThinkingBlockProps {
  messageId: string;
  text: string;
  isStreaming: boolean;
  /**
   * True when a vendor process wrote this, not a MangoStudio model. Vendor text
   * is rendered literally — markdown here would let a third party emit links and
   * images into MangoStudio's own UI.
   */
  plainText?: boolean;
}

/**
 * One thought, as a single timeline row that opens onto the reasoning itself.
 *
 * The elapsed time is measured here rather than read off the part, because a
 * thinking part carries no timestamps: a block that streamed in this session
 * reads "Thought for 4s", and one restored from a reloaded transcript reads
 * "Thought". Naming a duration nobody measured would be worse than omitting it.
 */
export function ThinkingBlock({
  messageId,
  text,
  isStreaming,
  plainText = false,
}: ThinkingBlockProps) {
  const { t } = useI18n();
  const initialUiStateRef = useRef<ThinkingUiState>(
    thinkingUiStateByMessage.get(messageId) ?? {
      expanded: isStreaming,
      scrollTop: 0,
      shouldAutoFollow: isStreaming,
      ...(isStreaming ? { startedAt: performance.now() } : {}),
    }
  );
  const [expanded, setExpanded] = useState(initialUiStateRef.current.expanded);
  const [durationMs, setDurationMs] = useState(initialUiStateRef.current.durationMs);
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
      updateUiState({ expanded: true, shouldAutoFollow: true, startedAt: performance.now() });
    }
    if (previousStreamingRef.current && !isStreaming) {
      const startedAt = uiStateRef.current.startedAt;
      const elapsed = startedAt === undefined ? undefined : performance.now() - startedAt;
      // eslint-disable-next-line @eslint-react/set-state-in-effect
      setExpanded(false);
      // eslint-disable-next-line @eslint-react/set-state-in-effect
      if (elapsed !== undefined) setDurationMs(elapsed);
      updateUiState({
        expanded: false,
        shouldAutoFollow: false,
        ...(elapsed === undefined ? {} : { durationMs: elapsed }),
      });
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

  // `chat.feed.thoughtFor` is the same sentence an image turn already prints
  // for its own elapsed time; a second key holding the same string would only
  // give the two translations a way to drift apart.
  const label = isStreaming
    ? t.thinking.streaming
    : durationMs === undefined
      ? t.thinking.thought
      : formatMessage(t.chat.feed.thoughtFor, { time: formatThinkingDuration(durationMs) });

  return (
    <TimelineItem tone={isStreaming ? 'active' : 'muted'}>
      {/* No glyph: a thought is the one step with no outcome to report, and the
          empty status column is what sets it apart from the calls around it. */}
      <TimelineRow expanded={expanded} onToggle={handleToggle}>
        <span
          className={`truncate ${isStreaming ? 'animate-pulse text-on-surface-variant' : 'text-on-surface-variant/55'}`}
        >
          {label}
        </span>
      </TimelineRow>
      <TimelineDisclosure open={expanded}>
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="app-scrollbar max-h-48 overflow-y-auto p-3.5 sm:max-h-72 md:max-h-96"
        >
          <div className="markdown-content--thinking text-xs leading-relaxed text-on-surface-variant/60">
            {plainText ? (
              <span
                data-vendor-text
                className={`block whitespace-pre-wrap break-words${isStreaming ? ' streaming-caret' : ''}`}
              >
                {text}
              </span>
            ) : (
              <MarkdownContent
                content={text}
                isStreaming={isStreaming}
                copyCodeLabel={t.chat.copyCode}
                codeCopiedLabel={t.chat.codeCopied}
              />
            )}
          </div>
        </div>
      </TimelineDisclosure>
    </TimelineItem>
  );
}
