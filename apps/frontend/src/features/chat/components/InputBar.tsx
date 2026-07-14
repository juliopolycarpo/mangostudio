import type { ReasoningEffort } from '@mangostudio/shared';
import type { AgentExecutionMode, AgentProfile } from '@mangostudio/shared/agents';
import type { ChatAttachment } from '@mangostudio/shared/chat';
import { FileText, Image, Mic, Send, Square, X } from 'lucide-react';
import { useState } from 'react';
import { ThinkingToggle } from '@/components/layout/ThinkingToggle';
import type { ContextInfo } from '@/features/generation/types';
import { useI18n } from '@/hooks/use-i18n';
import { CapabilityInspector } from './CapabilityInspector';
import { McpComposerMenu } from './McpComposerMenu';

function formatTokensCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

interface Props {
  onSubmit: (prompt: string, attachmentIds?: string[]) => void;
  chatId?: string | null;
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
  activeModel?: string | null;
  agentExecutionMode?: AgentExecutionMode;
  selectedAgentId?: string;
  agents?: ReadonlyArray<AgentProfile>;
  isAgentListLoading?: boolean;
  onAgentExecutionModeChange?: (mode: AgentExecutionMode) => void;
  onSelectedAgentIdChange?: (agentId: string) => void;
}

export function InputBar({
  onSubmit,
  chatId = null,
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
  activeModel = null,
  agentExecutionMode = 'chat',
  selectedAgentId = 'default',
  agents = [],
  isAgentListLoading = false,
  onAgentExecutionModeChange,
  onSelectedAgentIdChange,
}: Props) {
  const { t } = useI18n();
  const [prompt, setPrompt] = useState('');
  const [pendingAttachments, setPendingAttachments] = useState<ChatAttachment[]>([]);
  const selectableAgents = agents.filter(
    (agent) => agent.role === 'primary' || agent.role === 'both'
  );

  const handleSubmit = (e: { preventDefault: () => void }) => {
    e.preventDefault();
    if (!prompt.trim() || disabled || submitDisabled) return;
    const attachmentIds = pendingAttachments.map((attachment) => attachment.id);
    onSubmit(prompt, attachmentIds.length > 0 ? attachmentIds : undefined);
    setPrompt('');
    setPendingAttachments([]);
  };

  const handleInsertPrompt = (text: string) => {
    if (!text) return;
    setPrompt((current) => (current.trim() ? `${current}\n\n${text}` : text));
  };

  const handleAttachments = (attachments: ChatAttachment[]) => {
    if (attachments.length === 0) return;
    setPendingAttachments((current) => {
      const known = new Set(current.map((attachment) => attachment.id));
      return [...current, ...attachments.filter((attachment) => !known.has(attachment.id))];
    });
  };

  return (
    <footer className="shrink-0 p-3 sm:p-4 md:p-6">
      <div className="max-w-4xl mx-auto w-full">
        <div className="flex items-center justify-between mb-2 sm:mb-3">
          <div className="flex items-center gap-2 flex-wrap">
            {onAgentExecutionModeChange ? (
              <div className="flex items-center rounded-full border border-outline-variant/20 bg-surface-container-lowest p-0.5 text-[10px] sm:text-[11px] font-medium">
                {(['chat', 'agent'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => onAgentExecutionModeChange(mode)}
                    disabled={disabled}
                    className={`rounded-full px-2.5 py-1 transition-colors ${
                      agentExecutionMode === mode
                        ? 'bg-primary text-on-primary shadow-sm'
                        : 'text-on-surface-variant hover:text-on-surface'
                    }`}
                    aria-pressed={agentExecutionMode === mode}
                  >
                    {mode === 'chat' ? t.chat.input.modeChat : t.chat.input.modeAgent}
                  </button>
                ))}
              </div>
            ) : null}

            {agentExecutionMode === 'agent' && onSelectedAgentIdChange ? (
              <label className="sr-only" htmlFor="chat-agent-selector">
                {t.chat.input.selectAgent}
              </label>
            ) : null}
            {agentExecutionMode === 'agent' && onSelectedAgentIdChange ? (
              <select
                id="chat-agent-selector"
                value={selectedAgentId}
                onChange={(event) => onSelectedAgentIdChange(event.target.value)}
                disabled={disabled || isAgentListLoading || selectableAgents.length === 0}
                className="h-7 max-w-[11rem] rounded-full border border-outline-variant/20 bg-surface-container-lowest px-2 text-[10px] sm:text-[11px] font-medium text-on-surface-variant outline-none transition-colors hover:text-on-surface focus:border-primary/40"
                aria-label={t.chat.input.selectAgent}
              >
                {isAgentListLoading ? (
                  <option value={selectedAgentId}>{t.chat.input.agentsLoading}</option>
                ) : null}
                {selectableAgents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </select>
            ) : null}

            {onThinkingToggle && onReasoningEffortChange ? (
              <ThinkingToggle
                enabled={thinkingEnabled}
                effort={reasoningEffort}
                visible={reasoningVisible}
                onToggle={onThinkingToggle}
                onEffortChange={onReasoningEffortChange}
              />
            ) : null}

            <McpComposerMenu
              chatId={chatId}
              disabled={disabled}
              onInsertPrompt={handleInsertPrompt}
              onAttachments={handleAttachments}
            />

            <CapabilityInspector
              chatId={chatId}
              disabled={disabled}
              activeModel={activeModel}
              agentMode={agentExecutionMode}
              selectedAgentId={agentExecutionMode === 'agent' ? selectedAgentId : undefined}
            />

            {onImageToolIntentChange && (
              <button
                type="button"
                onClick={() => onImageToolIntentChange(!imageToolIntent)}
                disabled={disabled}
                className={`flex items-center gap-1.5 px-2 py-0.5 sm:px-2.5 sm:py-1 rounded-full text-[10px] sm:text-[11px] font-medium transition-all duration-200 shrink-0 ${
                  imageToolIntent
                    ? 'bg-primary text-on-primary shadow-sm'
                    : 'text-on-surface-variant hover:text-on-surface border border-outline-variant/20 hover:border-outline-variant/40'
                }`}
                title={t.chat.input.createImagesHint}
              >
                <Image size={12} className="sm:hidden" />
                <Image size={13} className="hidden sm:block" />
                <span className="hidden sm:inline">{t.chat.input.createImages}</span>
              </button>
            )}

            {contextInfo && (
              <span
                className={`flex items-center gap-1 px-2 py-0.5 sm:px-2.5 sm:py-1 rounded-full text-[10px] sm:text-[11px] font-medium tabular-nums border transition-colors shrink-0 ${
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
                <span className="sm:hidden">
                  {formatTokensCompact(contextInfo.estimatedInputTokens)}
                </span>
                <span className="hidden sm:inline">
                  {`${t.chat.context.label}: ${formatTokensCompact(contextInfo.estimatedInputTokens)} / ${formatTokensCompact(contextInfo.contextLimit)}`}
                </span>
              </span>
            )}
          </div>
        </div>

        {pendingAttachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {pendingAttachments.map((attachment) => (
              <span
                key={attachment.id}
                className="flex items-center gap-1.5 rounded-full border border-outline-variant/20 bg-surface-container-lowest px-2.5 py-1 text-[11px] text-on-surface-variant"
              >
                <FileText size={12} className="shrink-0 text-primary/70" />
                <span className="max-w-[12rem] truncate">{attachment.originalName}</span>
                <button
                  type="button"
                  onClick={() =>
                    setPendingAttachments((current) =>
                      current.filter((pending) => pending.id !== attachment.id)
                    )
                  }
                  className="text-on-surface-variant/60 hover:text-on-surface"
                  aria-label={t.chat.input.removeAttachment}
                >
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        )}

        <form
          onSubmit={handleSubmit}
          className="bg-surface-container-lowest border border-outline-variant/10 rounded-2xl p-1.5 sm:p-2 shadow-2xl flex items-center gap-1.5 sm:gap-2 group transition-all focus-within:ring-1 focus-within:ring-primary/30"
        >
          <input
            type="text"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            disabled={disabled}
            className="flex-1 bg-transparent border-none focus:ring-0 text-sm font-body text-on-surface placeholder:text-on-surface-variant/40 py-2 outline-none min-w-0"
            placeholder={t.chat.input.placeholder}
          />

          <div className="flex items-center gap-1 pr-0.5 sm:pr-1 shrink-0">
            {!isGenerating && (
              <button
                type="button"
                className="w-9 h-9 sm:w-10 sm:h-10 flex items-center justify-center rounded-xl text-on-surface-variant hover:bg-surface-container-high transition-all"
              >
                <Mic size={18} className="sm:hidden" />
                <Mic size={20} className="hidden sm:block" />
              </button>
            )}
            {isGenerating ? (
              <button
                type="button"
                onClick={onStop}
                className="h-9 sm:h-10 px-3 sm:px-4 rounded-xl font-bold text-xs flex items-center gap-1.5 sm:gap-2 transition-all active:scale-95 bg-surface-container-high text-on-surface hover:bg-error/20 hover:text-error shrink-0"
              >
                <span className="hidden sm:inline">{t.chat.input.stop}</span>{' '}
                <Square size={12} className="sm:hidden" />
                <Square size={14} className="hidden sm:block" />
              </button>
            ) : (
              <button
                type="submit"
                disabled={disabled || submitDisabled || !prompt.trim()}
                className="h-9 sm:h-10 px-3 sm:px-4 rounded-xl text-on-primary font-bold text-xs flex items-center gap-1.5 sm:gap-2 hover:brightness-110 transition-all active:scale-95 shadow-lg shadow-primary-container/20 disabled:opacity-50 shrink-0"
                style={{ background: 'var(--gradient-primary)' }}
              >
                <span className="hidden sm:inline">{t.chat.input.send}</span>{' '}
                <Send size={14} className="sm:hidden" />
                <Send size={16} className="hidden sm:block" />
              </button>
            )}
          </div>
        </form>
        <p className="text-center text-[10px] text-on-surface-variant/40 mt-2 sm:mt-3 font-label">
          {t.common.disclaimer}
        </p>
      </div>
    </footer>
  );
}
