import React, { useState, useRef, useEffect } from 'react';
import { MessageSquare, ImagePlus, PlusCircle, Mic, Zap, Send, Square, X } from 'lucide-react';
import type { InteractionMode, ReasoningEffort } from '@mangostudio/shared';
import { ThinkingToggle } from '@/components/layout/ThinkingToggle';
import { useI18n } from '@/hooks/use-i18n';
import type { ContextInfo } from '@/hooks/use-text-chat';

function formatTokensCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

interface Props {
  composerMode: InteractionMode;
  onModeChange: (mode: InteractionMode) => void;
  onSubmit: (prompt: string, referenceImage?: File | null) => void;
  disabled?: boolean;
  isGenerating?: boolean;
  onStop?: () => void;
  // Thinking / reasoning controls
  thinkingEnabled?: boolean;
  reasoningEffort?: ReasoningEffort;
  onThinkingToggle?: (enabled: boolean) => void;
  onReasoningEffortChange?: (effort: ReasoningEffort) => void;
  reasoningVisible?: boolean;
  // Context window info
  contextInfo?: ContextInfo | null;
}

export function InputBar({
  composerMode,
  onModeChange,
  onSubmit,
  disabled,
  isGenerating,
  onStop,
  thinkingEnabled = false,
  reasoningEffort = 'medium',
  onThinkingToggle,
  onReasoningEffortChange,
  reasoningVisible = false,
  contextInfo,
}: Props) {
  const { t } = useI18n();
  const [prompt, setPrompt] = useState('');
  const [referenceImage, setReferenceImage] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isImageMode = composerMode === 'image';

  useEffect(() => {
    if (referenceImage) {
      const url = URL.createObjectURL(referenceImage);
      // TODO(react-compiler): URL lifecycle (createObjectURL/revokeObjectURL) requires useEffect.
      // eslint-disable-next-line react-hooks/set-state-in-effect
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
        {/* Bottom toolbar: reasoning controls (left) + mode switch (right) */}
        <div className="flex items-center justify-between mb-3">
          {/* Left side: thinking toggle + context chip */}
          <div className="flex items-center gap-2">
            {onThinkingToggle && onReasoningEffortChange ? (
              <ThinkingToggle
                enabled={thinkingEnabled}
                effort={reasoningEffort}
                visible={reasoningVisible}
                onToggle={onThinkingToggle}
                onEffortChange={onReasoningEffortChange}
              />
            ) : null}

            {/* Context chip — shown when context info is available */}
            {contextInfo && composerMode === 'chat' && (
              <span
                className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-medium tabular-nums border transition-colors ${
                  contextInfo.severity === 'critical'
                    ? 'bg-error/15 text-error border-error/30'
                    : contextInfo.severity === 'danger'
                      ? 'bg-warning/15 text-warning border-warning/30'
                      : contextInfo.severity === 'warning'
                        ? 'bg-warning/10 text-warning/80 border-warning/20'
                        : 'bg-surface-container-high text-on-surface-variant border-transparent'
                }`}
                title={`~${contextInfo.estimatedInputTokens.toLocaleString()} / ${contextInfo.contextLimit.toLocaleString()} tokens · ${contextInfo.mode}`}
              >
                {`Context: ${formatTokensCompact(contextInfo.estimatedInputTokens)} / ${formatTokensCompact(contextInfo.contextLimit)}`}
              </span>
            )}
          </div>

          {/* Mode Switch Toggle */}
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
                style={{ background: 'var(--gradient-primary)' }}
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
          {t.common.disclaimer}
        </p>
      </div>
    </footer>
  );
}
