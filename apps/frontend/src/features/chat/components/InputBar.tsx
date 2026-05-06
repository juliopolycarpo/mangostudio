import { useState } from 'react';
import { Mic, Send, Square, Image } from 'lucide-react';
import type { ReasoningEffort } from '@mangostudio/shared';
import { ThinkingToggle } from '@/components/layout/ThinkingToggle';
import { useI18n } from '@/hooks/use-i18n';
import type { ContextInfo } from '@/features/generation/types';

function formatTokensCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

interface Props {
  onSubmit: (prompt: string) => void;
  disabled?: boolean;
  submitDisabled?: boolean;
  isGenerating?: boolean;
  onStop?: () => void;
  thinkingEnabled?: boolean;
  reasoningEffort?: ReasoningEffort;
  onThinkingToggle?: (enabled: boolean) => void;
  onReasoningEffortChange?: (effort: ReasoningEffort) => void;
  reasoningVisible?: boolean;
  contextInfo?: ContextInfo | null;
  imageToolIntent?: boolean;
  onImageToolIntentChange?: (active: boolean) => void;
}

export function InputBar({
  onSubmit,
  disabled,
  submitDisabled = false,
  isGenerating,
  onStop,
  thinkingEnabled = false,
  reasoningEffort = 'medium',
  onThinkingToggle,
  onReasoningEffortChange,
  reasoningVisible = false,
  contextInfo,
  imageToolIntent = false,
  onImageToolIntentChange,
}: Props) {
  const { t } = useI18n();
  const [prompt, setPrompt] = useState('');

  const handleSubmit = (e: { preventDefault: () => void }) => {
    e.preventDefault();
    if (!prompt.trim() || disabled || submitDisabled) return;
    onSubmit(prompt);
    setPrompt('');
  };

  return (
    <footer className="shrink-0 p-6">
      <div className="max-w-4xl mx-auto w-full">
        <div className="flex items-center justify-between mb-3">
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

            {onImageToolIntentChange && (
              <button
                type="button"
                onClick={() => onImageToolIntentChange(!imageToolIntent)}
                disabled={disabled}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium transition-all duration-200 ${
                  imageToolIntent
                    ? 'bg-primary text-on-primary shadow-sm'
                    : 'text-on-surface-variant hover:text-on-surface border border-outline-variant/20 hover:border-outline-variant/40'
                }`}
                title={t.chat.input.createImagesHint}
              >
                <Image size={13} />
                {t.chat.input.createImages}
              </button>
            )}

            {contextInfo && (
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
                {`${t.chat.context.label}: ${formatTokensCompact(contextInfo.estimatedInputTokens)} / ${formatTokensCompact(contextInfo.contextLimit)}`}
              </span>
            )}
          </div>
        </div>

        <form
          onSubmit={handleSubmit}
          className="bg-surface-container-lowest border border-outline-variant/10 rounded-2xl p-2 shadow-2xl flex items-center gap-2 group transition-all focus-within:ring-1 focus-within:ring-primary/30"
        >
          <input
            type="text"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            disabled={disabled}
            className="flex-1 bg-transparent border-none focus:ring-0 text-sm font-body text-on-surface placeholder:text-on-surface-variant/40 py-2 outline-none"
            placeholder={t.chat.input.placeholder}
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
            {isGenerating ? (
              <button
                type="button"
                onClick={onStop}
                className="h-10 px-4 rounded-xl font-bold text-xs flex items-center gap-2 transition-all active:scale-95 bg-surface-container-high text-on-surface hover:bg-error/20 hover:text-error"
              >
                {t.chat.input.stop} <Square size={14} />
              </button>
            ) : (
              <button
                type="submit"
                disabled={disabled || submitDisabled || !prompt.trim()}
                className="h-10 px-4 rounded-xl text-on-primary font-bold text-xs flex items-center gap-2 hover:brightness-110 transition-all active:scale-95 shadow-lg shadow-primary-container/20 disabled:opacity-50"
                style={{ background: 'var(--gradient-primary)' }}
              >
                {t.chat.input.send} <Send size={16} />
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
