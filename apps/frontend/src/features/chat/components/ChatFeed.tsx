/* global document */
import type { GeneratedImagePart, Message, MessagePart } from '@mangostudio/shared';
import {
  Sparkles,
  Download,
  Bookmark,
  ImageOff,
  Image,
  Copy,
  Check,
  ArrowDown,
} from 'lucide-react';
import { format } from 'date-fns';
import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useI18n } from '@/hooks/use-i18n';
import { MarkdownContent } from '@/components/MarkdownContent';
import { MessageParts } from './MessageParts';
import { ReservedAspectImage } from './ReservedAspectImage';

function isNearBottom(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= 24;
}

function extractRawMarkdown(msg: Message): string {
  const parts: MessagePart[] = msg.parts ?? (msg.text ? [{ type: 'text', text: msg.text }] : []);
  return parts
    .filter((p): p is Extract<MessagePart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n\n');
}

function messagePartsFromMessage(msg: Message): MessagePart[] {
  return msg.parts ?? (msg.text ? [{ type: 'text', text: msg.text }] : []);
}

function StreamingMessageBody({
  msg,
  isImageTurn,
  generatingImageLabel,
  streamingLabel,
}: {
  msg: Message;
  isImageTurn: boolean;
  generatingImageLabel: string;
  streamingLabel: string;
}) {
  const parts = messagePartsFromMessage(msg);
  const hasContent = parts.some(
    (p) => p.type === 'thinking' || p.type === 'text' || p.type === 'tool_call'
  );

  if (isImageTurn || !hasContent) {
    return (
      <>
        <span className="text-sm font-medium text-on-surface animate-pulse">
          {isImageTurn ? generatingImageLabel : streamingLabel}
        </span>
        {isImageTurn ? (
          <div className="h-1 w-24 bg-surface-container-highest rounded-full overflow-hidden">
            <div className="h-full bg-primary w-1/2 animate-[slide_1s_ease-in-out_infinite_alternate]"></div>
          </div>
        ) : (
          <div className="skeleton-pulse mt-1">
            <div className="skeleton-line" />
            <div className="skeleton-line" />
            <div className="skeleton-line" />
          </div>
        )}
      </>
    );
  }

  return <MessageParts parts={parts} messageId={msg.id} isStreaming />;
}

function CompletedMessageBody({ msg, noResponseLabel }: { msg: Message; noResponseLabel: string }) {
  const parts = messagePartsFromMessage(msg);
  const hasTextOrTools = parts.some((p) => p.type === 'text' || p.type === 'tool_call');

  return (
    <>
      <MessageParts parts={parts} messageId={msg.id} isStreaming={false} />
      {!hasTextOrTools && (
        <div className="bg-surface-container-low p-5 rounded-2xl border border-outline-variant/10 font-body text-sm leading-relaxed text-on-surface max-w-2xl">
          <span className="text-on-surface-variant/50 italic">{noResponseLabel}</span>
        </div>
      )}
    </>
  );
}

function CopyMessageButton({
  msg,
  label,
  copiedLabel,
}: {
  msg: Message;
  label: string;
  copiedLabel: string;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    const text = extractRawMarkdown(msg);
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API not available
    }
  };

  return (
    <button
      type="button"
      onClick={() => void handleCopy()}
      className="opacity-0 group-hover:opacity-70 hover:!opacity-100 transition-opacity duration-200 text-on-surface-variant/60 hover:text-on-surface-variant cursor-pointer"
      title={copied ? copiedLabel : label}
    >
      {copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
    </button>
  );
}

export function ChatFeed({ chatId, messages }: { chatId: string | null; messages: Message[] }) {
  const { t } = useI18n();
  const [imageErrors, setImageErrors] = useState<Record<string, boolean>>({});
  const [showScrollButton, setShowScrollButton] = useState(false);
  const parentRef = useRef<HTMLDivElement>(null);
  const feedShouldAutoFollowRef = useRef(true);
  const previousGeneratingMessageIdRef = useRef<string | null>(null);
  const pendingScrollToBottomRef = useRef(true);
  const previousChatIdRef = useRef<string | null>(chatId);

  const getScrollElement = useCallback(() => parentRef.current, []);
  const getItemKey = useCallback((index: number) => messages[index]?.id ?? index, [messages]);
  const estimateSize = useCallback(() => 150, []);

  const rowVirtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement,
    getItemKey,
    estimateSize,
    overscan: 5,
  });
  const latestMessage = messages.at(-1);
  const latestMessageId = latestMessage?.id ?? null;
  const latestIsGenerating = latestMessage?.isGenerating ?? false;
  // Track content length as a primitive to avoid the streaming scroll effect
  // re-firing on every in-place part update (e.g. image completion events).
  const latestPartsCount = latestMessage?.parts?.length ?? 0;
  const latestTextLen = latestMessage?.text?.length ?? 0;
  // When a generated image part transitions status (generating → completed),
  // the row height typically changes significantly. Capture that signal as a
  // primitive so the auto-follow layout effect re-scrolls to bottom.
  const latestImageCompletionSignature =
    latestMessage?.parts
      ?.filter((p): p is GeneratedImagePart => p.type === 'generated_image')
      .map((p) => `${p.imageId}:${p.status}:${p.imageUrl ?? ''}`)
      .join(',') ?? '';

  useEffect(() => {
    if (previousChatIdRef.current !== chatId) {
      previousChatIdRef.current = chatId;
      feedShouldAutoFollowRef.current = true;
      pendingScrollToBottomRef.current = true;
    }
  }, [chatId]);

  useLayoutEffect(() => {
    if (!pendingScrollToBottomRef.current || !parentRef.current || messages.length === 0) return;
    parentRef.current.scrollTop = parentRef.current.scrollHeight;
    pendingScrollToBottomRef.current = false;
  }, [chatId, messages.length]);

  // Keep auto-follow during streaming. The layout effect runs before paint,
  // so users do not see the one-frame pre-scroll position.
  useLayoutEffect(() => {
    const isNewGeneratingMessage =
      latestIsGenerating && previousGeneratingMessageIdRef.current !== latestMessageId;
    if (isNewGeneratingMessage) {
      feedShouldAutoFollowRef.current = true;
    }
    if (!latestIsGenerating || !parentRef.current) return;
    if (feedShouldAutoFollowRef.current) {
      parentRef.current.scrollTop = parentRef.current.scrollHeight;
    }
  }, [
    latestMessageId,
    latestIsGenerating,
    latestPartsCount,
    latestTextLen,
    latestImageCompletionSignature,
  ]);

  useEffect(() => {
    previousGeneratingMessageIdRef.current = latestIsGenerating ? latestMessageId : null;
  }, [latestMessageId, latestIsGenerating]);

  const handleFeedScroll = (event: React.UIEvent<HTMLElement>) => {
    const nearBottom = isNearBottom(event.currentTarget);
    if (!nearBottom) {
      feedShouldAutoFollowRef.current = false;
    } else {
      feedShouldAutoFollowRef.current = true;
    }
    // Suppress the button while auto-following so transient position
    // changes during content growth (e.g. image loads) don't flash it.
    setShowScrollButton(!feedShouldAutoFollowRef.current && !nearBottom);
  };

  const handleScrollToBottom = () => {
    if (!parentRef.current) return;
    feedShouldAutoFollowRef.current = true;
    parentRef.current.scrollTo({ top: parentRef.current.scrollHeight, behavior: 'smooth' });
  };

  const handleImageError = (id: string) => {
    setImageErrors((prev) => ({ ...prev, [id]: true }));
  };

  const handleDownload = useCallback((imageUrl: string) => {
    const link = document.createElement('a');
    link.href = imageUrl;
    link.download = `gemini-art-${Date.now()}.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }, []);

  return (
    <section
      ref={parentRef}
      onScroll={handleFeedScroll}
      className="flex-1 min-h-0 overflow-y-auto px-3 sm:px-4 md:px-6 py-4 sm:py-6 md:py-8 hide-scrollbar max-w-5xl mx-auto w-full"
    >
      {messages.length === 0 && (
        <div className="flex flex-col items-center justify-center h-full text-on-surface-variant/50 px-4">
          <Sparkles size={48} className="mb-4 opacity-50" />
          <p className="text-lg font-headline text-center">{t.chat.feed.emptyTitle}</p>
          <p className="text-xs mt-2 text-on-surface-variant/40 text-center">
            {t.chat.feed.emptySubtitle}
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
                  paddingBottom: 'var(--chat-message-gap)',
                  willChange: 'transform',
                  contain: 'layout style paint',
                }}
              >
                <motion.div
                  initial={false}
                  animate={{ opacity: 1, y: 0 }}
                  className={`flex flex-col gap-2 ${msg.role === 'user' ? 'items-end ml-auto max-w-[92%] sm:max-w-[85%] md:max-w-[80%]' : 'items-start mr-auto max-w-full'}`}
                >
                  {msg.role === 'user' ? (
                    <>
                      {msg.referenceImage && (
                        <div className="mb-2 max-w-[200px] rounded-xl overflow-hidden border border-outline-variant/20 shadow-sm">
                          {imageErrors[`ref-${msg.id}`] ? (
                            <div className="w-full aspect-square bg-surface-container-high flex flex-col items-center justify-center text-on-surface-variant/50 p-4 text-center">
                              <ImageOff size={24} className="mb-2" />
                              <span className="text-[10px] font-label">
                                {t.chat.feed.imageUnavailable}
                              </span>
                            </div>
                          ) : (
                            <ReservedAspectImage
                              src={msg.referenceImage}
                              alt="Reference"
                              onLoadError={() => handleImageError(`ref-${msg.id}`)}
                            />
                          )}
                        </div>
                      )}
                      <div className="flex flex-col items-end gap-1.5">
                        <div className="px-5 py-3 rounded-2xl bg-surface-container-low text-on-surface border border-outline-variant/10 font-body chat-message-body leading-relaxed">
                          <MarkdownContent
                            content={msg.text}
                            copyCodeLabel={t.chat.copyCode}
                            codeCopiedLabel={t.chat.codeCopied}
                          />
                        </div>
                        {isImageTurn && (
                          <span className="flex items-center gap-1 text-[10px] font-bold text-primary/70 font-label px-1">
                            <Image size={11} />
                            {t.chat.feed.createImageBadge}
                          </span>
                        )}
                      </div>
                      <span className="text-[10px] text-on-surface-variant font-label px-2">
                        {format(msg.timestamp, 'h:mm a')}
                      </span>
                    </>
                  ) : (
                    <div className="group flex flex-col gap-4 w-full">
                      <div className="flex items-center gap-3">
                        <div className="w-6 h-6 rounded-full bg-primary-container flex items-center justify-center">
                          <Sparkles size={14} className="text-on-primary" />
                        </div>
                        <span className="text-xs font-bold font-headline tracking-wide uppercase text-primary">
                          {msg.modelName
                            ? `${
                                msg.isGenerating
                                  ? isImageTurn
                                    ? t.chat.feed.statusGenerating
                                    : t.chat.feed.statusThinking
                                  : isImageTurn
                                    ? t.chat.feed.statusGenerated
                                    : t.chat.feed.statusReplied
                              } with: ${msg.modelName}`
                            : 'Gemini'}
                        </span>
                        {!msg.isGenerating && !isImageTurn && (
                          <CopyMessageButton
                            msg={msg}
                            label={t.chat.copyMessage}
                            copiedLabel={t.chat.messageCopied}
                          />
                        )}
                        {!msg.isGenerating && (
                          <span className="opacity-0 group-hover:opacity-100 transition-opacity duration-200 text-[10px] text-on-surface-variant/50 font-label ml-auto">
                            {format(msg.timestamp, 'h:mm a')}
                          </span>
                        )}
                      </div>

                      {msg.isGenerating ? (
                        <div className="flex flex-col gap-3 py-4 pl-9">
                          <StreamingMessageBody
                            msg={msg}
                            isImageTurn={isImageTurn}
                            generatingImageLabel={t.chat.feed.generatingImage}
                            streamingLabel={t.thinking.streaming}
                          />
                        </div>
                      ) : isImageTurn ? (
                        <div className="flex flex-col gap-4 w-full">
                          {msg.generationTime && (
                            <div className="flex items-center gap-2 text-xs text-on-surface-variant bg-surface-container-lowest py-2 px-3 rounded-lg w-fit border border-outline-variant/10">
                              <Sparkles size={12} className="text-primary" />
                              <span>
                                {t.chat.feed.thoughtFor.replace('{time}', msg.generationTime)}
                              </span>
                            </div>
                          )}
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-start w-full">
                            {msg.imageUrl && (
                              <div className="group relative bg-surface-container-lowest rounded-xl overflow-hidden aspect-[4/5] shadow-2xl transition-transform duration-500 hover:scale-[1.01]">
                                {imageErrors[`gen-${msg.id}`] ? (
                                  <div className="w-full h-full flex flex-col items-center justify-center text-on-surface-variant/50 p-6 text-center bg-surface-container-high">
                                    <ImageOff size={48} className="mb-4 opacity-50" />
                                    <p className="font-headline font-bold mb-2">
                                      {t.chat.feed.imageUnavailable}
                                    </p>
                                    <p className="text-xs font-body">
                                      {t.chat.feed.imageUnavailableHint}
                                    </p>
                                  </div>
                                ) : (
                                  <>
                                    <img
                                      src={msg.imageUrl}
                                      alt="Generated"
                                      className="w-full h-full object-cover grayscale-[20%] group-hover:grayscale-0 transition-[filter] duration-700"
                                      decoding="async"
                                      onError={() => handleImageError(`gen-${msg.id}`)}
                                    />
                                    <div className="absolute bottom-4 left-4 right-4 glass-panel rounded-xl p-3 flex justify-between items-center translate-y-12 opacity-0 group-hover:translate-y-0 group-hover:opacity-100 transition-all duration-300">
                                      <div className="flex gap-2">
                                        <button
                                          onClick={() => {
                                            if (msg.imageUrl) handleDownload(msg.imageUrl);
                                          }}
                                          className="w-9 h-9 rounded-lg flex items-center justify-center bg-surface-container-highest/40 hover:bg-primary/20 text-on-surface transition-colors"
                                          title={t.chat.feed.download}
                                        >
                                          <Download size={16} />
                                        </button>
                                        <button
                                          className="w-9 h-9 rounded-lg flex items-center justify-center bg-surface-container-highest/40 hover:bg-primary/20 text-on-surface transition-colors"
                                          title={t.chat.feed.saveToGallery}
                                        >
                                          <Bookmark size={16} />
                                        </button>
                                      </div>
                                      <button className="px-4 py-1.5 rounded-lg bg-primary/10 hover:bg-primary/20 text-primary text-xs font-bold transition-colors">
                                        {t.chat.feed.regenerate}
                                      </button>
                                    </div>
                                  </>
                                )}
                              </div>
                            )}
                            <div className="space-y-6">
                              {msg.styleParams && msg.styleParams.length > 0 && (
                                <div className="bg-surface-container-low p-6 rounded-xl border border-outline-variant/5">
                                  <h3 className="font-headline text-sm font-bold mb-4 flex items-center gap-2 text-on-surface">
                                    <Sparkles className="text-primary" size={16} />
                                    {t.chat.feed.styleParams}
                                  </h3>
                                  <div className="flex flex-wrap gap-2">
                                    {msg.styleParams.map((param) => (
                                      <span
                                        key={param}
                                        className="px-3 py-1 bg-surface-container-high text-on-surface-variant text-[10px] font-bold rounded-sm uppercase tracking-wider"
                                      >
                                        {param}
                                      </span>
                                    ))}
                                  </div>
                                </div>
                              )}
                              {msg.text && !msg.imageUrl && (
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
                        <div className="flex flex-col gap-3">
                          {msg.generationTime && (
                            <div className="flex items-center gap-2 text-xs text-on-surface-variant bg-surface-container-lowest py-2 px-3 rounded-lg w-fit border border-outline-variant/10">
                              <Sparkles size={12} className="text-primary" />
                              <span>
                                {t.chat.feed.respondedIn.replace('{time}', msg.generationTime)}
                              </span>
                            </div>
                          )}
                          <CompletedMessageBody
                            msg={msg}
                            noResponseLabel={t.chat.feed.noResponse}
                          />
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

      <AnimatePresence>
        {showScrollButton && messages.length > 0 && (
          <motion.button
            key="scroll-to-bottom"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            transition={{ duration: 0.2 }}
            type="button"
            onClick={handleScrollToBottom}
            className="glass-elevated sticky bottom-4 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium text-on-surface-variant border border-outline-variant/30 cursor-pointer hover:border-outline-variant/50 hover:text-on-surface transition-colors duration-200"
            title={t.chat.scrollToBottom}
          >
            <ArrowDown size={13} />
            {t.chat.scrollToBottom}
          </motion.button>
        )}
      </AnimatePresence>
    </section>
  );
}
