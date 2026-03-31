/* global document */
import type { Message, MessagePart } from '@mangostudio/shared';
import { Sparkles, Download, Bookmark, ImageOff, Image, Brain, ChevronDown } from 'lucide-react';
import { format } from 'date-fns';
import { motion } from 'motion/react';
import { useState, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useI18n } from '@/hooks/use-i18n';

function ThinkingBlock({ text, isStreaming }: { text: string; isStreaming: boolean }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="mb-3">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 text-xs text-on-surface-variant bg-surface-container-lowest
                   py-2 px-3 rounded-lg w-fit border border-outline-variant/10 hover:bg-surface-container-low
                   transition-colors cursor-pointer"
      >
        <Brain size={12} className="text-primary" />
        <span>{isStreaming ? t.thinking.streaming : t.thinking.label}</span>
        <ChevronDown size={12} className={`transition-transform ${expanded ? 'rotate-180' : ''}`} />
      </button>
      {expanded && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          className="mt-2 bg-surface-container-lowest p-4 rounded-xl border border-outline-variant/10
                     text-xs text-on-surface-variant font-mono leading-relaxed whitespace-pre-wrap max-h-64 overflow-y-auto"
        >
          {text}
          {isStreaming && (
            <span className="inline-block w-0.5 h-[1em] bg-primary/50 ml-0.5 align-middle animate-blink" />
          )}
        </motion.div>
      )}
    </div>
  );
}

export function ChatFeed({ messages }: { messages: Message[] }) {
  const [imageErrors, setImageErrors] = useState<Record<string, boolean>>({});
  const parentRef = useRef<HTMLDivElement>(null);

  const rowVirtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 150,
    overscan: 5,
  });

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
                          {msg.text}
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
                            const isThinkingOnly = !!thinkingPart && !combinedText;

                            if (isImageTurn || (!msg.text && !thinkingPart)) {
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
                              <div className="flex flex-col gap-3">
                                {thinkingPart && (
                                  <ThinkingBlock
                                    text={(thinkingPart as { type: 'thinking'; text: string }).text}
                                    isStreaming={isThinkingOnly}
                                  />
                                )}
                                {combinedText && (
                                  <div className="bg-surface-container-low p-5 rounded-2xl border border-outline-variant/10 font-body text-sm leading-relaxed text-on-surface whitespace-pre-wrap max-w-2xl">
                                    {combinedText}
                                    <span className="inline-block w-0.5 h-[1em] bg-primary ml-0.5 align-middle animate-blink" />
                                  </div>
                                )}
                              </div>
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

                            return (
                              <>
                                {thinkingPart && (
                                  <ThinkingBlock
                                    text={(thinkingPart as { type: 'thinking'; text: string }).text}
                                    isStreaming={false}
                                  />
                                )}
                                <div className="bg-surface-container-low p-5 rounded-2xl border border-outline-variant/10 font-body text-sm leading-relaxed text-on-surface whitespace-pre-wrap max-w-2xl">
                                  {combinedText || (
                                    <span className="text-on-surface-variant/50 italic">
                                      No response
                                    </span>
                                  )}
                                </div>
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
