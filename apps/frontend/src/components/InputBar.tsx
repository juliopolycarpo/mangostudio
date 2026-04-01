import React, { useState, useRef, useEffect } from 'react';
import {
  MessageSquare,
  ImagePlus,
  PlusCircle,
  Mic,
  Zap,
  Send,
  Square,
  X,
  Brain,
  ChevronDown,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { useI18n } from '@/hooks/use-i18n';
import type { InteractionMode } from '@mangostudio/shared';

interface Props {
  composerMode: InteractionMode;
  onModeChange: (mode: InteractionMode) => void;
  onSubmit: (prompt: string, referenceImage?: File | null) => void;
  disabled?: boolean;
  isGenerating?: boolean;
  onStop?: () => void;
  streamingThinking?: string;
}

export function InputBar({
  composerMode,
  onModeChange,
  onSubmit,
  disabled,
  isGenerating,
  onStop,
  streamingThinking,
}: Props) {
  const { t } = useI18n();
  const [thinkingExpanded, setThinkingExpanded] = useState(true);
  const [prompt, setPrompt] = useState('');
  const [referenceImage, setReferenceImage] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isImageMode = composerMode === 'image';

  useEffect(() => {
    if (referenceImage) {
      const url = URL.createObjectURL(referenceImage);
      setPreviewUrl(url);
      return () => URL.revokeObjectURL(url);
    } else {
      setPreviewUrl(null);
    }
  }, [referenceImage]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setReferenceImage(file);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim() || disabled) return;
    onSubmit(prompt, referenceImage);
    setPrompt('');
    setReferenceImage(null);
  };

  return (
    <footer className="shrink-0 p-6">
      <div className="max-w-4xl mx-auto w-full">
        {/* Streaming thinking panel — above input, aligned left */}
        <AnimatePresence>
          {streamingThinking && isGenerating && (
            <motion.div
              key="thinking-panel"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 4 }}
              transition={{ duration: 0.2, ease: 'easeOut' }}
              className="mb-3"
            >
              <button
                onClick={() => setThinkingExpanded(!thinkingExpanded)}
                className="flex items-center gap-2 text-xs text-on-surface-variant/70
                           py-1.5 px-3 rounded-full w-fit border border-outline-variant/20
                           hover:border-outline-variant/40 hover:text-on-surface-variant
                           transition-all duration-200 cursor-pointer mb-1.5"
                style={{ background: 'rgba(14,14,14,0.6)', backdropFilter: 'blur(8px)' }}
              >
                <Brain size={11} className="text-primary/70" />
                <span className="tracking-wide">{t.thinking.streaming}</span>
                <ChevronDown
                  size={11}
                  className={`transition-transform duration-300 text-primary/50 ${
                    thinkingExpanded ? 'rotate-180' : ''
                  }`}
                />
              </button>
              <AnimatePresence>
                {thinkingExpanded && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.2, ease: 'easeOut' }}
                    className="rounded-xl border border-outline-variant/15 overflow-hidden"
                    style={{ background: 'rgba(14,14,14,0.5)', backdropFilter: 'blur(12px)' }}
                  >
                    <div className="p-4 max-h-40 overflow-y-auto app-scrollbar">
                      <p className="text-xs text-on-surface-variant/60 font-mono leading-relaxed whitespace-pre-wrap">
                        {streamingThinking}
                        <span className="inline-block w-0.5 h-[1em] bg-primary/40 ml-0.5 align-middle animate-blink" />
                      </p>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          )}
        </AnimatePresence>
        {/* Mode Switch Toggle */}
        <div className="flex justify-center mb-3">
          <div className="inline-flex bg-surface-container-low border border-outline-variant/10 rounded-full p-1 gap-1 shadow-sm">
            <button
              type="button"
              onClick={() => onModeChange('chat')}
              className={`flex items-center gap-2 px-4 py-1.5 rounded-full text-xs font-bold transition-all duration-200 ${
                !isImageMode
                  ? 'bg-primary text-on-primary shadow-md'
                  : 'text-on-surface-variant hover:text-on-surface'
              }`}
            >
              <MessageSquare size={13} />
              Chat
            </button>
            <button
              type="button"
              onClick={() => onModeChange('image')}
              className={`flex items-center gap-2 px-4 py-1.5 rounded-full text-xs font-bold transition-all duration-200 ${
                isImageMode
                  ? 'bg-primary text-on-primary shadow-md'
                  : 'text-on-surface-variant hover:text-on-surface'
              }`}
            >
              <ImagePlus size={13} />
              Create Image
            </button>
          </div>
        </div>

        {/* Reference image preview (image mode only) */}
        {isImageMode && previewUrl && (
          <div className="mb-2 relative inline-block">
            <img
              src={previewUrl}
              alt="Reference"
              className="h-20 w-20 object-cover rounded-xl border-2 border-primary/30 shadow-lg"
              loading="lazy"
              decoding="async"
            />
            <button
              onClick={() => setReferenceImage(null)}
              className="absolute -top-2 -right-2 w-6 h-6 bg-surface-container-highest text-on-surface rounded-full flex items-center justify-center hover:bg-error hover:text-on-error transition-colors shadow-md"
            >
              <X size={14} />
            </button>
          </div>
        )}

        <form
          onSubmit={handleSubmit}
          className="bg-surface-container-lowest border border-outline-variant/10 rounded-2xl p-2 shadow-2xl flex items-center gap-2 group transition-all focus-within:ring-1 focus-within:ring-primary/30"
        >
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileChange}
            accept="image/png, image/jpeg"
            className="hidden"
          />

          {/* Upload button — only visible in image mode */}
          {isImageMode && (
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="w-10 h-10 flex items-center justify-center rounded-xl text-on-surface-variant hover:bg-surface-container-high hover:text-primary transition-all active:scale-95"
              title="Add reference image"
            >
              <PlusCircle size={24} />
            </button>
          )}

          <input
            type="text"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            disabled={disabled}
            className="flex-1 bg-transparent border-none focus:ring-0 text-sm font-body text-on-surface placeholder:text-on-surface-variant/40 py-2 outline-none"
            placeholder={isImageMode ? 'Describe your image...' : 'Ask Gemini anything...'}
          />

          <div className="flex items-center gap-1 pr-1">
            {!isGenerating && (
              <button
                type="button"
                className="w-10 h-10 flex items-center justify-center rounded-xl text-on-surface-variant hover:bg-surface-container-high transition-all"
              >
                <Mic size={20} />
              </button>
            )}
            {isGenerating && !isImageMode ? (
              <button
                type="button"
                onClick={onStop}
                className="h-10 px-4 rounded-xl font-bold text-xs flex items-center gap-2 transition-all active:scale-95 bg-surface-container-high text-on-surface hover:bg-error/20 hover:text-error"
              >
                Stop <Square size={14} />
              </button>
            ) : (
              <button
                type="submit"
                disabled={disabled || !prompt.trim()}
                className="h-10 px-4 rounded-xl text-on-primary font-bold text-xs flex items-center gap-2 hover:brightness-110 transition-all active:scale-95 shadow-lg shadow-primary-container/20 disabled:opacity-50"
                style={{ background: 'linear-gradient(135deg, #c0c1ff 0%, #4b4dd8 100%)' }}
              >
                {isImageMode ? (
                  <>
                    Generate <Zap size={16} />
                  </>
                ) : (
                  <>
                    Send <Send size={16} />
                  </>
                )}
              </button>
            )}
          </div>
        </form>
        <p className="text-center text-[10px] text-on-surface-variant/40 mt-3 font-label">
          {isImageMode
            ? 'MangoStudio may produce unexpected results. Review images before sharing.'
            : 'Gemini can make mistakes. Double-check important information.'}
        </p>
      </div>
    </footer>
  );
}
