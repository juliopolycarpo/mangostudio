import type {
  ModelCatalogResponse,
  ModelOption,
  ProviderType,
  ReasoningEffort,
} from '@mangostudio/shared';
import type { AgentProfile } from '@mangostudio/shared/agents';
import type { ChatAttachment, ChatRunnerConfiguration } from '@mangostudio/shared/chat';
import type {
  ExternalAgentDescriptor,
  ExternalApprovalRouting,
  ExternalPermissionLevel,
  ExternalThreadUsage,
} from '@mangostudio/shared/external-agents';
import {
  AlertTriangle,
  CornerDownRight,
  FileText,
  FolderOpen,
  Image,
  Mic,
  Send,
  Square,
  X,
} from 'lucide-react';
import { useRef, useState } from 'react';
import { ModelSelector } from '@/components/layout/ModelSelector';
import { ThinkingToggle } from '@/components/layout/ThinkingToggle';
import { Button } from '@/components/ui/Button';
import { Chip } from '@/components/ui/Chip';
import { KbdHint } from '@/components/ui/KbdHint';
import { EnvironmentSelector } from '@/features/environments/components/EnvironmentSelector';
import { ExternalComposerControls } from '@/features/external-agents/ExternalComposerControls';
import { ExternalUsageDisplay } from '@/features/external-agents/ExternalUsageDisplay';
import { externalAgentSelectable } from '@/features/external-agents/useExternalAgents';
import type { ContextInfo } from '@/features/generation/types';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_MD, ICON_SM } from '@/lib/icon-sizes';
import { steerExternalTurn } from '@/services/external-agent-service';
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
  /** Vendor thread usage for this chat; nothing renders until a turn reports it. */
  threadUsage?: ExternalThreadUsage | null;
  imageToolIntent?: boolean;
  onImageToolIntentChange?: (active: boolean) => void;
  activeModel?: string | null;
  selectedAgentId?: string;
  agents?: ReadonlyArray<AgentProfile>;
  isAgentListLoading?: boolean;
  onSelectedAgentIdChange?: (agentId: string) => void;
  environmentId?: string | null;
  onEnvironmentChange?: (environmentId: string) => void | Promise<void>;
  workdir?: string | null;
  onWorkdirClick?: () => void;
  /** Who runs the turn. Decides which of the two control sets renders at all. */
  runner?: ChatRunnerConfiguration;
  activeModels?: ModelOption[];
  modelCatalog?: ModelCatalogResponse;
  lockedProvider?: ProviderType | null;
  isModelSelectorDisabled?: boolean;
  onModelChange?: (model: string) => void;
  externalDescriptor?: ExternalAgentDescriptor;
  externalModel?: string | null;
  externalEffort?: string | null;
  externalLevel?: ExternalPermissionLevel;
  externalRouting?: ExternalApprovalRouting;
  onExternalModelChange?: (model: string | null) => void;
  onExternalEffortChange?: (effort: string | null) => void;
  onExternalPermissionsChange?: (next: {
    level: ExternalPermissionLevel;
    routing: ExternalApprovalRouting;
  }) => void;
}

function getWorkdirName(workdir: string): string {
  const withoutTrailingSeparators = workdir.replace(/[\\/]+$/, '');
  if (!withoutTrailingSeparators) return workdir;
  return withoutTrailingSeparators.split(/[\\/]/).filter(Boolean).at(-1) ?? workdir;
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
  threadUsage = null,
  imageToolIntent = false,
  onImageToolIntentChange,
  activeModel = null,
  selectedAgentId = 'default',
  agents = [],
  isAgentListLoading = false,
  onSelectedAgentIdChange,
  environmentId = null,
  onEnvironmentChange,
  workdir = null,
  onWorkdirClick,
  runner,
  activeModels = [],
  modelCatalog,
  lockedProvider,
  isModelSelectorDisabled = false,
  onModelChange,
  externalDescriptor,
  externalModel = null,
  externalEffort = null,
  externalLevel = 'read-only',
  externalRouting = 'user',
  onExternalModelChange,
  onExternalEffortChange,
  onExternalPermissionsChange,
}: Props) {
  const { t } = useI18n();
  const [prompt, setPrompt] = useState('');
  const [pendingAttachments, setPendingAttachments] = useState<ChatAttachment[]>([]);
  const [steering, setSteering] = useState(false);
  const [steerError, setSteerError] = useState<string | null>(null);
  const pendingSteerId = useRef<string | null>(null);
  const selectableAgents = agents.filter(
    (agent) => agent.role === 'primary' || agent.role === 'both'
  );
  // The model moved here from the header, and it renders per runner: MangoStudio
  // always has a catalog, an external agent only when its vendor advertised one.
  const isExternalRunner = runner?.kind === 'external';
  const workdirName = workdir ? getWorkdirName(workdir) : null;

  /**
   * A persisted external runner that cannot start a turn right now.
   *
   * The runner outlives the conditions that made it selectable — discovery is
   * still loading, the runtime dropped, the vendor signed out — and the composer
   * would otherwise stay fully enabled, because nothing else here depends on the
   * descriptor. The turn would be refused server-side, so the cost of not
   * blocking is a send that reads as accepted and comes back as an error with
   * nothing on screen explaining which of those four things happened.
   *
   * A missing descriptor is included deliberately: whether discovery has not
   * answered yet or the environment has no such agent, this runner cannot host a
   * turn either way.
   */
  const externalUnavailableReason = externalDescriptor?.unavailableReason;
  // `disclosure-required` is checked on top of `externalAgentSelectable`, which
  // deliberately leaves it selectable so the *selector* can route the user into
  // the notice. There is no such route from here: the turn-start gate refuses
  // the send with a 403 nothing on this screen handles, so a composer that
  // stayed enabled would accept a message and lose it to a bare error.
  const externalRunnerBlocked =
    isExternalRunner &&
    (!externalDescriptor ||
      !externalAgentSelectable(externalDescriptor) ||
      externalUnavailableReason === 'disclosure-required');
  const cannotSubmit = submitDisabled || externalRunnerBlocked;

  /**
   * Whether *this* runner ever accepts a correction mid-turn, independent of
   * whether one is running right now. `steering: true` is Codex only — see
   * `docs/architecture/external-agents.md` — and a runner that cannot host a
   * turn at all cannot steer one either.
   */
  const steerable =
    isExternalRunner &&
    externalDescriptor?.capabilities.steering === true &&
    !externalRunnerBlocked;
  const showSteerAffordance = steerable && isGenerating === true;

  const handleSteer = async (text: string) => {
    if (!chatId || steering) return;
    setSteering(true);
    setSteerError(null);
    try {
      const clientMessageId = pendingSteerId.current ?? crypto.randomUUID();
      pendingSteerId.current = clientMessageId;
      const result = await steerExternalTurn(chatId, {
        clientMessageId,
        text,
      });
      pendingSteerId.current = null;
      setPrompt('');
      // The outcome itself renders inline in the turn once the live stream
      // reports it; this is only for a rejection nobody else will surface.
      if (!result.accepted) setSteerError(t.externalAgents.steer.reason[result.reasonCode]);
    } catch {
      setSteerError(t.externalAgents.steer.submitError);
    } finally {
      setSteering(false);
    }
  };

  const handleSubmit = (e: { preventDefault: () => void }) => {
    e.preventDefault();
    if (!prompt.trim()) return;
    // `disabled` is `isGenerating` at the call site, which is exactly the
    // state a steerable runner's affordance exists to submit through — so
    // this branch has to run before that check, not be exempted from it.
    if (showSteerAffordance) {
      if (!chatId || steering) return;
      void handleSteer(prompt);
      return;
    }
    if (disabled || cannotSubmit) return;
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
            {environmentId && onEnvironmentChange ? (
              <EnvironmentSelector
                environmentId={environmentId}
                disabled={disabled || isGenerating}
                onEnvironmentChange={onEnvironmentChange}
              />
            ) : null}

            {!isExternalRunner && onSelectedAgentIdChange ? (
              <label className="sr-only" htmlFor="chat-agent-selector">
                {t.chat.input.selectAgent}
              </label>
            ) : null}

            {onWorkdirClick ? (
              <Chip
                icon={<FolderOpen size={13} className="shrink-0 text-primary/80" />}
                onClick={onWorkdirClick}
                disabled={disabled}
                className="h-7 max-w-[14rem]"
                title={workdir ?? t.workspace.chooseWorkdir}
                aria-label={
                  workdirName
                    ? t.workspace.changeWorkdir.replace('{name}', workdirName)
                    : t.workspace.chooseWorkdir
                }
              >
                {workdirName ?? t.workspace.chooseWorkdir}
              </Chip>
            ) : null}
            {!isExternalRunner && onSelectedAgentIdChange ? (
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

            {!isExternalRunner && modelCatalog && onModelChange ? (
              <ModelSelector
                activeModel={activeModel ?? ''}
                activeModels={activeModels}
                isDisabled={isModelSelectorDisabled || disabled === true}
                onSelect={onModelChange}
                modelCatalog={modelCatalog}
                lockedProvider={lockedProvider}
              />
            ) : null}

            {isExternalRunner &&
            onExternalModelChange &&
            onExternalEffortChange &&
            onExternalPermissionsChange ? (
              <ExternalComposerControls
                descriptor={externalDescriptor}
                model={externalModel}
                effort={externalEffort}
                level={externalLevel}
                routing={externalRouting}
                disabled={disabled || isGenerating}
                onModelChange={onExternalModelChange}
                onEffortChange={onExternalEffortChange}
                onPermissionsChange={onExternalPermissionsChange}
              />
            ) : null}

            {/* MangoStudio's own thinking control. An external agent's effort
                comes from its vendor's per-model catalog instead. */}
            {!isExternalRunner && onThinkingToggle && onReasoningEffortChange ? (
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
              selectedAgentId={selectedAgentId}
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

            <ExternalUsageDisplay turn={threadUsage?.last} thread={threadUsage} />
          </div>
        </div>

        {externalRunnerBlocked && (
          // Named, not just disabled: "install it", "sign in", "wake that
          // machine" and "wait for discovery" are four different things to do,
          // and a composer that goes quiet without saying which leaves the user
          // clicking Send at nothing.
          <p role="status" className="mb-2 flex items-center gap-1.5 text-[11px] text-warning">
            <AlertTriangle size={12} className="shrink-0" />
            {externalUnavailableReason
              ? `${t.externalAgents.unavailable[externalUnavailableReason]} — ${t.externalAgents.selector.unavailableHere}`
              : t.externalAgents.selector.unavailableHere}
          </p>
        )}

        {steerError && (
          <p role="status" className="mb-2 flex items-center gap-1.5 text-[11px] text-error">
            <AlertTriangle size={12} className="shrink-0" />
            {steerError}
          </p>
        )}

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
            onChange={(e) => {
              setPrompt(e.target.value);
              if (steerError) setSteerError(null);
            }}
            disabled={(disabled && !showSteerAffordance) || externalRunnerBlocked || steering}
            className="flex-1 bg-transparent border-none focus:ring-0 text-sm font-body text-on-surface placeholder:text-on-surface-variant/40 py-2 outline-none min-w-0"
            placeholder={
              showSteerAffordance ? t.externalAgents.steer.buttonHint : t.chat.input.placeholder
            }
          />

          <div className="flex items-center gap-1 pr-0.5 sm:pr-1 shrink-0">
            {!isGenerating && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="sm:size-10 text-on-surface-variant"
              >
                <Mic size={18} className="sm:hidden" />
                <Mic size={20} className="hidden sm:block" />
              </Button>
            )}
            {isGenerating && (
              <Button
                type="button"
                variant="secondary"
                onClick={onStop}
                title={t.chat.input.stop}
                className={`text-xs hover:bg-error/20 hover:text-error shrink-0 ${
                  showSteerAffordance
                    ? 'size-9 sm:size-10 p-0'
                    : 'h-9 sm:h-10 gap-1.5 px-3 sm:gap-2 sm:px-4'
                }`}
              >
                {!showSteerAffordance && (
                  <span className="hidden sm:inline">{t.chat.input.stop}</span>
                )}{' '}
                <Square size={12} className="sm:hidden" />
                <Square size={14} className="hidden sm:block" />
              </Button>
            )}
            {/* Same button, different meaning while a steerable turn runs — see
                docs/architecture/external-agents.md's steering section. Distinct
                styling so nobody reads it as an ordinary send. */}
            {showSteerAffordance ? (
              <Button
                type="submit"
                variant="ghost"
                disabled={!chatId || steering || !prompt.trim()}
                title={t.externalAgents.steer.buttonHint}
                className="h-9 sm:h-10 px-3 sm:px-4 gap-1.5 sm:gap-2 border-2 border-primary text-primary text-xs hover:bg-primary/10 hover:text-primary shrink-0"
              >
                <span className="hidden sm:inline">{t.externalAgents.steer.button}</span>{' '}
                <CornerDownRight size={ICON_SM} className="sm:hidden" />
                <CornerDownRight size={ICON_MD} className="hidden sm:block" />
              </Button>
            ) : !isGenerating ? (
              <Button
                type="submit"
                disabled={disabled || cannotSubmit || !prompt.trim()}
                className="h-9 sm:h-10 px-3 sm:px-4 gap-1.5 sm:gap-2 text-xs shadow-primary-container/20 hover:brightness-110 hover:opacity-100 shrink-0"
                style={{ background: 'var(--gradient-primary)' }}
              >
                <span className="hidden sm:inline">{t.chat.input.send}</span>{' '}
                <Send size={ICON_SM} className="sm:hidden" />
                <KbdHint
                  keys="⏎"
                  className="hidden sm:inline-flex border-transparent bg-on-primary/15 text-on-primary/90"
                />
              </Button>
            ) : null}
          </div>
        </form>
        <p className="text-center text-[10px] text-on-surface-variant/40 mt-2 sm:mt-3 font-label">
          {t.common.disclaimer}
        </p>
      </div>
    </footer>
  );
}
