/* global document */
import type { Message, MessagePart } from '@mangostudio/shared';
import {
  Sparkles,
  Download,
  Bookmark,
  ImageOff,
  Image,
  Brain,
  ChevronDown,
  Wrench,
  CheckCircle,
  AlertCircle,
} from 'lucide-react';
import { format } from 'date-fns';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useI18n } from '@/hooks/use-i18n';
import { MarkdownContent } from '@/components/MarkdownContent';

interface ThinkingBlockProps {
  messageId: string;
  text: string;
  isStreaming: boolean;
}

interface ThinkingUiState {
  expanded: boolean;
  scrollTop: number;
  shouldAutoFollow: boolean;
}

const thinkingUiStateByMessage = new Map<string, ThinkingUiState>();

function isNearBottom(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= 24;
}

function ThinkingBlock({ messageId, text, isStreaming }: ThinkingBlockProps) {
  const { t } = useI18n();
  const initialUiState = useRef<ThinkingUiState>(
    thinkingUiStateByMessage.get(messageId) ?? {
      expanded: isStreaming,
      scrollTop: 0,
      shouldAutoFollow: isStreaming,
    }
  );
  const [expanded, setExpanded] = useState(initialUiState.current.expanded);
  const scrollRef = useRef<HTMLDivElement>(null);
  const uiStateRef = useRef(initialUiState.current);
  const previousStreamingRef = useRef(isStreaming);

  const updateUiState = (partial: Partial<ThinkingUiState>) => {
    uiStateRef.current = {
      ...uiStateRef.current,
      ...partial,
    };
    thinkingUiStateByMessage.set(messageId, uiStateRef.current);
  };

  useEffect(() => {
    if (!previousStreamingRef.current && isStreaming) {
      setExpanded(true);
      updateUiState({ expanded: true, shouldAutoFollow: true });
    }

    if (previousStreamingRef.current && !isStreaming) {
      setExpanded(false);
      updateUiState({ expanded: false, shouldAutoFollow: false });
    }

    previousStreamingRef.current = isStreaming;
  }, [isStreaming]);

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
  }, [expanded, isStreaming, text]);

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
        className="flex items-center gap-2 text-xs text-on-surface-variant/70
                   py-1.5 px-3 rounded-full w-fit border border-outline-variant/20
                   hover:border-outline-variant/40 hover:text-on-surface-variant
                   transition-all duration-200 cursor-pointer"
        style={{ background: 'rgba(14,14,14,0.6)', backdropFilter: 'blur(8px)' }}
      >
        <Brain size={11} className="text-primary/70" />
        <span className="tracking-wide">
          {isStreaming ? t.thinking.streaming : t.thinking.label}
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
            className="mt-1.5 rounded-xl border border-outline-variant/15 overflow-hidden"
            style={{ background: 'rgba(14,14,14,0.5)', backdropFilter: 'blur(12px)' }}
          >
            <div
              ref={scrollRef}
              onScroll={handleScroll}
              className="p-4 max-h-48 overflow-y-auto app-scrollbar"
            >
              <div className="text-xs text-on-surface-variant/60 leading-relaxed markdown-content--thinking">
                <MarkdownContent content={text} isStreaming={isStreaming} />
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

// ---------------------------------------------------------------------------
// ToolCallBlock
// ---------------------------------------------------------------------------

interface ToolCallBlockProps {
  name: string;
  args: Record<string, unknown>;
  result?: string | null;
  isError?: boolean;
  isPending?: boolean;
}

function ToolCallBlock({ name, args, result, isError, isPending }: ToolCallBlockProps) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);

  let parsedResult: unknown = null;
  if (result) {
    try {
      parsedResult = JSON.parse(result);
    } catch {
      parsedResult = result;
    }
  }

  return (
    <div className="mb-2">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-2 text-xs py-1.5 px-3 rounded-full w-fit border
                   transition-all duration-200 cursor-pointer"
        style={{
          background: 'rgba(14,14,14,0.6)',
          backdropFilter: 'blur(8px)',
          borderColor: isError
            ? 'rgba(239,68,68,0.3)'
            : isPending
              ? 'rgba(99,102,241,0.3)'
              : 'rgba(34,197,94,0.25)',
          color: isError
            ? 'rgba(239,68,68,0.9)'
            : isPending
              ? 'rgba(165,180,252,0.8)'
              : 'rgba(134,239,172,0.8)',
        }}
      >
        {isPending ? (
          <Wrench size={11} className="animate-pulse" />
        ) : isError ? (
          <AlertCircle size={11} />
        ) : (
          <CheckCircle size={11} />
        )}
        <span className="font-mono tracking-wide">
          {isPending ? t.tools.calling : isError ? t.tools.error : t.tools.done}{' '}
          <span className="opacity-70">{name}()</span>
        </span>
        <ChevronDown
          size={11}
          className={`transition-transform duration-300 opacity-50 ${expanded ? 'rotate-180' : ''}`}
        />
      </button>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            key="tool-body"
            initial={{ opacity: 0, height: 0, y: -4 }}
            animate={{ opacity: 1, height: 'auto', y: 0 }}
            exit={{ opacity: 0, height: 0, y: -6 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            className="mt-1.5 rounded-xl border border-outline-variant/15 overflow-hidden"
            style={{ background: 'rgba(14,14,14,0.5)', backdropFilter: 'blur(12px)' }}
          >
            <div className="p-4 space-y-3 text-xs font-mono">
              {Object.keys(args).length > 0 && (
                <div>
                  <p className="text-on-surface-variant/50 uppercase tracking-wider text-[10px] mb-1">
                    args
                  </p>
                  <pre className="text-on-surface-variant/70 whitespace-pre-wrap leading-relaxed">
                    {JSON.stringify(args, null, 2)}
                  </pre>
                </div>
              )}
              {parsedResult !== null && (
                <div>
                  <p
                    className={`uppercase tracking-wider text-[10px] mb-1 ${isError ? 'text-red-400/50' : 'text-on-surface-variant/50'}`}
                  >
                    {isError ? 'error' : 'result'}
                  </p>
                  <pre
                    className={`whitespace-pre-wrap leading-relaxed ${isError ? 'text-red-400/80' : 'text-on-surface-variant/70'}`}
                  >
                    {typeof parsedResult === 'string'
                      ? parsedResult
                      : JSON.stringify(parsedResult, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SystemEventMarker — inline timeline marker for recoverable events
// ---------------------------------------------------------------------------

function SystemEventMarker({ event, detail }: { event: string; detail?: string }) {
  const { t } = useI18n();

  let label: string;
  if (event === 'cursor_lost') {
    label = t.chat.cursorLost.replace('{detail}', detail ?? '');
  } else {
    label = detail ?? event;
  }

  return (
    <div className="flex items-center gap-2 py-2 text-xs text-on-surface-variant/60 my-1">
      <div className="flex-1 h-px bg-outline-variant/20" />
      <span className="font-medium whitespace-nowrap">{label}</span>
      <div className="flex-1 h-px bg-outline-variant/20" />
    </div>
  );
}

export function ChatFeed({ chatId, messages }: { chatId: string | null; messages: Message[] }) {
  const [imageErrors, setImageErrors] = useState<Record<string, boolean>>({});
  const parentRef = useRef<HTMLDivElement>(null);
  const feedShouldAutoFollowRef = useRef(true);
  const previousGeneratingMessageIdRef = useRef<string | null>(null);
  const pendingScrollToBottomRef = useRef(true);
  const previousChatIdRef = useRef<string | null>(chatId);

  const rowVirtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 150,
    overscan: 5,
  });
  const latestMessage = messages.at(-1);

  useEffect(() => {
    if (previousChatIdRef.current !== chatId) {
      previousChatIdRef.current = chatId;
      feedShouldAutoFollowRef.current = true;
      pendingScrollToBottomRef.current = true;
    }
  }, [chatId]);

  useLayoutEffect(() => {
    if (!pendingScrollToBottomRef.current || !parentRef.current || messages.length === 0) return;

    const animationFrameId = requestAnimationFrame(() => {
      const element = parentRef.current;
      if (!element) return;

      element.scrollTop = element.scrollHeight;
      pendingScrollToBottomRef.current = false;
    });

    return () => cancelAnimationFrame(animationFrameId);
  }, [chatId, messages.length, rowVirtualizer]);

  useLayoutEffect(() => {
    const isNewGeneratingMessage =
      latestMessage?.isGenerating && previousGeneratingMessageIdRef.current !== latestMessage.id;

    if (isNewGeneratingMessage) {
      feedShouldAutoFollowRef.current = true;
    }

    if (!latestMessage?.isGenerating || !parentRef.current) return;

    if (feedShouldAutoFollowRef.current) {
      parentRef.current.scrollTop = parentRef.current.scrollHeight;
    }
  }, [latestMessage?.id, latestMessage?.isGenerating, latestMessage?.parts, latestMessage?.text]);

  useEffect(() => {
    previousGeneratingMessageIdRef.current = latestMessage?.isGenerating ? latestMessage.id : null;
  }, [latestMessage?.id, latestMessage?.isGenerating, latestMessage?.parts, latestMessage?.text]);

  const handleFeedScroll = (event: React.UIEvent<HTMLElement>) => {
    feedShouldAutoFollowRef.current = isNearBottom(event.currentTarget);
  };

  const handleImageError = (id: string) => {
    setImageErrors((prev) => ({ ...prev, [id]: true }));
  };

  const handleDownload = (imageUrl: string) => {
    const link = document.createElement('a');
    link.href = imageUrl;
    link.download = `gemini-art-${Date.now()}.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <section
      ref={parentRef}
      onScroll={handleFeedScroll}
      className="flex-1 min-h-0 overflow-y-auto px-6 py-8 hide-scrollbar max-w-5xl mx-auto w-full"
    >
      {messages.length === 0 && (
        <div className="flex flex-col items-center justify-center h-full text-on-surface-variant/50">
          <Sparkles size={48} className="mb-4 opacity-50" />
          <p className="text-lg font-headline">Start a conversation or create an image</p>
          <p className="text-xs mt-2 text-on-surface-variant/40">
            Switch to Create Image mode to generate art
          </p>
        </div>
      )}

      {messages.length > 0 && (
        <div
          style={{
            height: `${rowVirtualizer.getTotalSize()}px`,
            width: '100%',
            position: 'relative',
          }}
        >
          {rowVirtualizer.getVirtualItems().map((virtualRow) => {
            const msg = messages[virtualRow.index];
            const isImageTurn =
              msg.interactionMode === 'image' || (!msg.interactionMode && !!msg.imageUrl);

            return (
              <div
                key={virtualRow.key}
                ref={rowVirtualizer.measureElement}
                data-index={virtualRow.index}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${virtualRow.start}px)`,
                  paddingBottom: '3rem', // spacing between messages
                }}
              >
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className={`flex flex-col gap-2 max-w-[80%] ${msg.role === 'user' ? 'items-end ml-auto' : 'items-start mr-auto max-w-full'}`}
                >
                  {msg.role === 'user' ? (
                    <>
                      {msg.referenceImage && (
                        <div className="mb-2 max-w-[200px] rounded-xl overflow-hidden border border-outline-variant/20 shadow-sm">
                          {imageErrors[`ref-${msg.id}`] ? (
                            <div className="w-full aspect-square bg-surface-container-high flex flex-col items-center justify-center text-on-surface-variant/50 p-4 text-center">
                              <ImageOff size={24} className="mb-2" />
                              <span className="text-[10px] font-label">
                                Image no longer available
                              </span>
                            </div>
                          ) : (
                            <img
                              src={msg.referenceImage}
                              alt="Reference"
                              className="w-full h-auto object-cover"
                              onError={() => handleImageError(`ref-${msg.id}`)}
                            />
                          )}
                        </div>
                      )}
                      <div className="flex flex-col items-end gap-1.5">
                        <div className="px-5 py-3 rounded-2xl bg-surface-container-low text-on-surface border border-outline-variant/10 font-body text-sm leading-relaxed">
                          <MarkdownContent content={msg.text} />
                        </div>
                        {/* Badge for image prompts */}
                        {isImageTurn && (
                          <span className="flex items-center gap-1 text-[10px] font-bold text-primary/70 font-label px-1">
                            <Image size={11} />
                            Create Image
                          </span>
                        )}
                      </div>
                      <span className="text-[10px] text-on-surface-variant font-label px-2">
                        {format(msg.timestamp, 'h:mm a')}
                      </span>
                    </>
                  ) : (
                    /* ── AI message ── */
                    <div className="flex flex-col gap-4 w-full">
                      <div className="flex items-center gap-3">
                        <div className="w-6 h-6 rounded-full bg-primary-container flex items-center justify-center">
                          <Sparkles size={14} className="text-on-primary" />
                        </div>
                        <span className="text-xs font-bold font-headline tracking-wide uppercase text-primary">
                          {msg.modelName
                            ? `${msg.isGenerating ? (isImageTurn ? 'Generating' : 'Thinking') : isImageTurn ? 'Generated' : 'Replied'} with: ${msg.modelName}`
                            : 'Gemini'}
                        </span>
                      </div>

                      {msg.isGenerating ? (
                        /* Loading / streaming state */
                        <div className="flex flex-col gap-3 py-4 pl-9">
                          {(() => {
                            const parts: MessagePart[] =
                              msg.parts ?? (msg.text ? [{ type: 'text', text: msg.text }] : []);
                            const thinkingPart = parts.find((p) => p.type === 'thinking');
                            const textParts = parts.filter((p) => p.type === 'text');
                            const combinedText = textParts
                              .map((p) => (p as { type: 'text'; text: string }).text)
                              .join('');
                            const toolCallParts = parts.filter(
                              (p) => p.type === 'tool_call'
                            ) as Extract<MessagePart, { type: 'tool_call' }>[];
                            const toolResultParts = parts.filter(
                              (p) => p.type === 'tool_result'
                            ) as Extract<MessagePart, { type: 'tool_result' }>[];
                            const systemEventParts = parts.filter(
                              (p) => p.type === 'system_event'
                            ) as Extract<MessagePart, { type: 'system_event' }>[];

                            if (
                              isImageTurn ||
                              (!msg.text &&
                                !combinedText &&
                                !thinkingPart &&
                                toolCallParts.length === 0)
                            ) {
                              return (
                                <>
                                  <span className="text-sm font-medium text-on-surface animate-pulse">
                                    {isImageTurn ? 'Generating image...' : 'Thinking...'}
                                  </span>
                                  <div className="h-1 w-24 bg-surface-container-highest rounded-full overflow-hidden">
                                    <div className="h-full bg-primary w-1/2 animate-[slide_1s_ease-in-out_infinite_alternate]"></div>
                                  </div>
                                </>
                              );
                            }

                            return (
                              <>
                                {thinkingPart && (
                                  <ThinkingBlock
                                    messageId={msg.id}
                                    text={(thinkingPart as { type: 'thinking'; text: string }).text}
                                    isStreaming={true}
                                  />
                                )}
                                {systemEventParts.map((se, idx) => (
                                  <SystemEventMarker
                                    key={`se-${idx}`}
                                    event={se.event}
                                    detail={se.detail}
                                  />
                                ))}
                                {toolCallParts.map((tc) => {
                                  const res = toolResultParts.find(
                                    (r) => r.toolCallId === tc.toolCallId
                                  );
                                  return (
                                    <ToolCallBlock
                                      key={tc.toolCallId}
                                      name={tc.name}
                                      args={tc.args}
                                      result={res?.content ?? null}
                                      isError={res?.isError}
                                      isPending={!res}
                                    />
                                  );
                                })}
                                {combinedText && (
                                  <div className="bg-surface-container-low p-5 rounded-2xl border border-outline-variant/10 font-body text-sm leading-relaxed text-on-surface max-w-2xl">
                                    <MarkdownContent content={combinedText} isStreaming />
                                    <span className="inline-block w-0.5 h-[1em] bg-primary ml-0.5 align-middle animate-blink" />
                                  </div>
                                )}
                              </>
                            );
                          })()}
                        </div>
                      ) : isImageTurn ? (
                        /* ── Image turn result ── */
                        <div className="flex flex-col gap-4 w-full">
                          {msg.generationTime && (
                            <div className="flex items-center gap-2 text-xs text-on-surface-variant bg-surface-container-lowest py-2 px-3 rounded-lg w-fit border border-outline-variant/10">
                              <Sparkles size={12} className="text-primary" />
                              <span>Thought for {msg.generationTime}</span>
                            </div>
                          )}
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-start w-full">
                            {msg.imageUrl && (
                              <div className="group relative bg-surface-container-lowest rounded-xl overflow-hidden aspect-[4/5] shadow-2xl transition-transform duration-500 hover:scale-[1.01]">
                                {imageErrors[`gen-${msg.id}`] ? (
                                  <div className="w-full h-full flex flex-col items-center justify-center text-on-surface-variant/50 p-6 text-center bg-surface-container-high">
                                    <ImageOff size={48} className="mb-4 opacity-50" />
                                    <p className="font-headline font-bold mb-2">
                                      Image no longer available
                                    </p>
                                    <p className="text-xs font-body">
                                      (Have you deleted or moved the image?)
                                    </p>
                                  </div>
                                ) : (
                                  <>
                                    <img
                                      src={msg.imageUrl}
                                      alt="Generated"
                                      className="w-full h-full object-cover grayscale-[20%] group-hover:grayscale-0 transition-all duration-700"
                                      onError={() => handleImageError(`gen-${msg.id}`)}
                                      onLoad={() => rowVirtualizer.measureElement(null)} // re-measure after load
                                    />
                                    <div className="absolute bottom-4 left-4 right-4 glass-panel rounded-xl p-3 flex justify-between items-center translate-y-12 opacity-0 group-hover:translate-y-0 group-hover:opacity-100 transition-all duration-300">
                                      <div className="flex gap-2">
                                        <button
                                          onClick={() => handleDownload(msg.imageUrl!)}
                                          className="w-9 h-9 rounded-lg flex items-center justify-center bg-surface-container-highest/40 hover:bg-primary/20 text-on-surface transition-colors"
                                          title="Download"
                                        >
                                          <Download size={16} />
                                        </button>
                                        <button
                                          className="w-9 h-9 rounded-lg flex items-center justify-center bg-surface-container-highest/40 hover:bg-primary/20 text-on-surface transition-colors"
                                          title="Save to Gallery"
                                        >
                                          <Bookmark size={16} />
                                        </button>
                                      </div>
                                      <button className="px-4 py-1.5 rounded-lg bg-primary/10 hover:bg-primary/20 text-primary text-xs font-bold transition-colors">
                                        Regenerate
                                      </button>
                                    </div>
                                  </>
                                )}
                              </div>
                            )}
                            {/* Style params panel */}
                            <div className="space-y-6">
                              {msg.styleParams && msg.styleParams.length > 0 && (
                                <div className="bg-surface-container-low p-6 rounded-xl border border-outline-variant/5">
                                  <h3 className="font-headline text-sm font-bold mb-4 flex items-center gap-2 text-on-surface">
                                    <Sparkles className="text-primary" size={16} />
                                    Style Parameters
                                  </h3>
                                  <div className="flex flex-wrap gap-2">
                                    {msg.styleParams.map((param, i) => (
                                      <span
                                        key={i}
                                        className="px-3 py-1 bg-surface-container-high text-on-surface-variant text-[10px] font-bold rounded-sm uppercase tracking-wider"
                                      >
                                        {param}
                                      </span>
                                    ))}
                                  </div>
                                </div>
                              )}
                              {msg.text && !msg.imageUrl && (
                                /* Error message when generation fails */
                                <div className="bg-error/10 border border-error/20 p-4 rounded-xl text-error text-sm font-body">
                                  {msg.text}
                                </div>
                              )}
                              {!msg.text && !msg.imageUrl && !msg.isGenerating && (
                                <div className="bg-surface-container-lowest p-6 rounded-xl border border-outline-variant/5">
                                  <p className="font-body text-xs text-on-surface-variant leading-relaxed">
                                    Using{' '}
                                    <span className="text-primary-fixed-dim italic">
                                      Neural Diffusion Path
                                    </span>
                                    .
                                  </p>
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      ) : (
                        /* ── Text turn result ── */
                        <div className="flex flex-col gap-3">
                          {msg.generationTime && (
                            <div className="flex items-center gap-2 text-xs text-on-surface-variant bg-surface-container-lowest py-2 px-3 rounded-lg w-fit border border-outline-variant/10">
                              <Sparkles size={12} className="text-primary" />
                              <span>Responded in {msg.generationTime}</span>
                            </div>
                          )}
                          {(() => {
                            const parts: MessagePart[] =
                              msg.parts ?? (msg.text ? [{ type: 'text', text: msg.text }] : []);
                            const thinkingPart = parts.find((p) => p.type === 'thinking');
                            const textParts = parts.filter((p) => p.type === 'text');
                            const combinedText = textParts
                              .map((p) => (p as { type: 'text'; text: string }).text)
                              .join('');
                            const toolCallParts = parts.filter(
                              (p) => p.type === 'tool_call'
                            ) as Extract<MessagePart, { type: 'tool_call' }>[];
                            const toolResultParts = parts.filter(
                              (p) => p.type === 'tool_result'
                            ) as Extract<MessagePart, { type: 'tool_result' }>[];
                            const systemEventParts = parts.filter(
                              (p) => p.type === 'system_event'
                            ) as Extract<MessagePart, { type: 'system_event' }>[];

                            return (
                              <>
                                {thinkingPart && (
                                  <ThinkingBlock
                                    messageId={msg.id}
                                    text={(thinkingPart as { type: 'thinking'; text: string }).text}
                                    isStreaming={false}
                                  />
                                )}
                                {systemEventParts.map((se, idx) => (
                                  <SystemEventMarker
                                    key={`se-${idx}`}
                                    event={se.event}
                                    detail={se.detail}
                                  />
                                ))}
                                {toolCallParts.map((tc) => {
                                  const res = toolResultParts.find(
                                    (r) => r.toolCallId === tc.toolCallId
                                  );
                                  return (
                                    <ToolCallBlock
                                      key={tc.toolCallId}
                                      name={tc.name}
                                      args={tc.args}
                                      result={res?.content ?? null}
                                      isError={res?.isError}
                                      isPending={false}
                                    />
                                  );
                                })}
                                {(combinedText || toolCallParts.length === 0) && (
                                  <div className="bg-surface-container-low p-5 rounded-2xl border border-outline-variant/10 font-body text-sm leading-relaxed text-on-surface max-w-2xl">
                                    {combinedText ? (
                                      <MarkdownContent content={combinedText} />
                                    ) : (
                                      <span className="text-on-surface-variant/50 italic">
                                        No response
                                      </span>
                                    )}
                                  </div>
                                )}
                              </>
                            );
                          })()}
                        </div>
                      )}
                    </div>
                  )}
                </motion.div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
