import type { ChatAttachment, ChatRunnerConfiguration } from '@mangostudio/shared/chat';
import type { ExternalAgentDescriptor } from '@mangostudio/shared/external-agents';
import { AlertTriangle, CornerDownRight, FileText, Send, Square, X } from 'lucide-react';
import {
  type CSSProperties,
  type DragEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Button } from '@/components/ui/Button';
import { KbdHint } from '@/components/ui/KbdHint';
import { externalAgentSelectable } from '@/features/external-agents/useExternalAgents';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { ICON_MD, ICON_SM } from '@/lib/icon-sizes';
import { steerExternalTurn } from '@/services/external-agent-service';
import { filesFromClipboard, useComposerAttachments } from '../hooks/use-composer-attachments';
import { useComposerDraft } from '../hooks/use-composer-draft';
import { usePromptHistory } from '../hooks/use-prompt-history';
import { useSlashCommands } from '../hooks/use-slash-commands';
import { COMPOSER_ACCENT_PROPERTY, composerAccent } from '../lib/composer-accent';
import { onComposerFocusRequest } from '../lib/composer-draft-store';
import {
  applySlashCompletion,
  matchSlashCommands,
  nextSlashIndex,
  type SlashCommandEntry,
  slashQueryAt,
} from '../lib/slash-commands';
import { CapabilityInspector } from './CapabilityInspector';
import { ComposerChipRow, type ComposerChipRowProps } from './ComposerChipRow';
import { ImageIntentToggle } from './ImageIntentToggle';
import { McpComposerMenu } from './McpComposerMenu';
import { SlashCommandMenu } from './SlashCommandMenu';

/** Roughly eight lines before the box stops growing and starts scrolling. */
const TEXTAREA_MAX_HEIGHT_PX = 200;

/**
 * The status line's own props, which the composer only relays.
 *
 * Declared by subtraction rather than restated: these used to be written out
 * three times here — in the interface, in the destructure, and in the forward —
 * so every chip added to the status line cost four edits across two files for a
 * component with no opinion about it. The six left out are the ones the
 * composer itself reads.
 */
type ForwardedChipRowProps = Omit<
  ComposerChipRowProps,
  | 'isExternalRunner'
  | 'disabled'
  | 'isGenerating'
  | 'activeModel'
  | 'selectedAgentId'
  | 'externalDescriptor'
>;

/**
 * What the status line falls back to when the composer is mounted without a
 * chat behind it. They live here rather than in `ComposerChipRow` because this
 * is the boundary where the props become optional.
 */
const CHIP_ROW_DEFAULTS = {
  thinkingEnabled: false,
  reasoningEffort: 'medium',
  reasoningVisible: false,
  threadUsage: null,
  agents: [],
  isAgentListLoading: false,
  hasTurns: false,
  workdir: null,
  activeModels: [],
  isModelSelectorDisabled: false,
  externalModel: null,
  externalEffort: null,
  externalLevel: 'read-only',
  externalRouting: 'user',
} satisfies Partial<ComposerChipRowProps>;

interface Props extends Partial<ForwardedChipRowProps> {
  onSubmit: (prompt: string, attachmentIds?: string[]) => void;
  chatId?: string | null;
  disabled?: boolean;
  submitDisabled?: boolean;
  isGenerating?: boolean;
  onStop?: () => void;
  imageToolIntent?: boolean;
  onImageToolIntentChange?: (active: boolean) => void;
  activeModel?: string | null;
  selectedAgentId?: string;
  /** Who runs the turn. Decides which of the two control sets renders at all. */
  runner?: ChatRunnerConfiguration;
  externalDescriptor?: ExternalAgentDescriptor;
}

export function InputBar({
  onSubmit,
  chatId = null,
  disabled,
  submitDisabled = false,
  isGenerating,
  onStop,
  imageToolIntent = false,
  onImageToolIntentChange,
  activeModel = null,
  selectedAgentId = 'default',
  runner,
  externalDescriptor,
  ...chipRow
}: Props) {
  const { t } = useI18n();
  const [prompt, setPrompt] = useComposerDraft(chatId);
  const [pendingAttachments, setPendingAttachments] = useState<ChatAttachment[]>([]);
  const [steering, setSteering] = useState(false);
  const [steerError, setSteerError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const pendingSteerId = useRef<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const history = usePromptHistory(chatId);

  // The model moved here from the header, and it renders per runner: MangoStudio
  // always has a catalog, an external agent only when its vendor advertised one.
  const isExternalRunner = runner?.kind === 'external';

  const handleAttachments = useCallback((attachments: ChatAttachment[]) => {
    if (attachments.length === 0) return;
    setPendingAttachments((current) => {
      const known = new Set(current.map((attachment) => attachment.id));
      return [...current, ...attachments.filter((attachment) => !known.has(attachment.id))];
    });
  }, []);

  const uploads = useComposerAttachments(chatId, handleAttachments);

  useAutoGrow(textareaRef, prompt);

  // The hub's prompt starters fill the composer from outside it; this is the
  // second half of that gesture.
  useEffect(() => onComposerFocusRequest(() => textareaRef.current?.focus()), []);

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
  const inputDisabled = (disabled && !showSteerAffordance) || externalRunnerBlocked || steering;

  // Naming the vendor here is the same courtesy the status line pays: the
  // composer is about to hand this text to a CLI running on someone's machine,
  // not to "the AI model". MangoStudio's own runner keeps the generic string —
  // it has no product name to say back to the user.
  const runnerName = runner?.kind === 'external' ? t.externalAgents.target[runner.targetId] : null;
  const placeholder = showSteerAffordance
    ? t.externalAgents.steer.buttonHint
    : runnerName
      ? formatMessage(t.chat.input.placeholderRunner, { agent: runnerName })
      : t.chat.input.placeholder;

  /**
   * The `/` palette.
   *
   * Driven by the caret rather than by a trigger key, so it survives the user
   * clicking back into a command they had already typed. `dismissed` is what
   * Escape sets: it must not be inferred from the text, or the palette would
   * reopen on the very next keystroke and Escape would do nothing.
   */
  const slashListId = useId();
  const [caret, setCaret] = useState(0);
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const slashQuery = slashDismissed || inputDisabled ? null : slashQueryAt(prompt, caret);
  const slashCommands = useSlashCommands({
    chatId,
    runner,
    environmentId: externalDescriptor?.environmentId ?? null,
    active: slashQuery !== null,
  });
  const slashMatches = useMemo(
    () => (slashQuery === null ? [] : matchSlashCommands(slashCommands.entries, slashQuery)),
    [slashCommands.entries, slashQuery]
  );
  // A bare `/` with nothing to offer stays quiet — an empty popover over every
  // slash would be noise. Once the user has typed a name, "no match" is worth
  // saying, because the alternative is a menu that silently vanishes. Not while
  // a source is still answering, though: a library scan walks directories on
  // the runtime host, and "No command matches" during that walk is a claim the
  // palette cannot support and the user will act on.
  const slashOpen =
    slashQuery !== null &&
    (slashMatches.length > 0 || (slashQuery.length > 0 && !slashCommands.loading));
  // Whether there is anything to *choose*. A palette showing "no match" must
  // not also take the arrow keys: they are the prompt history's, and swallowing
  // them would strand a user who typed a name that does not exist.
  const slashSelectable = slashOpen && slashMatches.length > 0;
  // Clamped where it is read rather than reset in an effect: a catalog
  // announced while the menu is open shortens the list, and an effect that
  // corrects the index only after paint leaves one render — and any keystroke
  // inside it — pointing past the end, at no row and at an
  // `aria-activedescendant` no option carries.
  const slashActiveIndex = Math.min(slashIndex, Math.max(slashMatches.length - 1, 0));

  // A new query is a new list; the highlight goes back to the best match.
  useEffect(() => setSlashIndex(0), [slashQuery]);

  // The palette's state belongs to the text it is showing over, and this
  // composer is not remounted when the chat changes — `useComposerDraft` swaps
  // the prompt under a caret still pointing into the previous chat's text. Left
  // alone, switching to a chat whose draft happens to start with `/` opens a
  // palette nobody asked for and hands it the arrows and Enter.
  useEffect(() => {
    setCaret(0);
    setSlashIndex(0);
    setSlashDismissed(false);
  }, [chatId]);

  const completeSlashCommand = (entry: SlashCommandEntry) => {
    const completion = applySlashCompletion(prompt, entry.name);
    setPrompt(completion.value);
    setSlashDismissed(true);
    setCaret(completion.caret);
    // Completing is editing by hand, the same as typing: leaving the history
    // cursor live over text the user did not recall means the next ↑ throws the
    // completion away instead of moving the caret.
    history.release();
    // After React has painted the new value: setting a range against the old
    // one puts the caret at a character that is no longer there.
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(completion.caret, completion.caret);
    });
  };

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
      history.record(prompt);
      void handleSteer(prompt);
      return;
    }
    if (disabled || cannotSubmit) return;
    const attachmentIds = pendingAttachments.map((attachment) => attachment.id);
    history.record(prompt);
    onSubmit(prompt, attachmentIds.length > 0 ? attachmentIds : undefined);
    setPrompt('');
    setPendingAttachments([]);
  };

  const handleInsertPrompt = (text: string) => {
    if (!text) return;
    setPrompt(prompt.trim() ? `${prompt}\n\n${text}` : text);
  };

  /**
   * Enter sends, Shift+Enter breaks the line, ↑/↓ walk this chat's history
   * while the caret is at the very start (or already inside history) so they
   * stay ordinary cursor keys in the middle of a multi-line prompt.
   */
  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // An IME candidate window uses Enter to accept a suggestion. `keyCode 229`
    // is the fallback for browsers that do not set `isComposing` on keydown.
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;

    // The palette owns Enter and the arrows while it is open, which is why it
    // is handled before the submit and history branches rather than inside
    // them: choosing a command is what those keys mean on screen right now.
    if (slashOpen && event.key === 'Escape') {
      event.preventDefault();
      setSlashDismissed(true);
      return;
    }
    if (slashSelectable) {
      // History keeps the arrows while it owns them. A recalled prompt that
      // happens to start with a command opens the palette without the user
      // asking, and taking ↑ there strands them mid-recall with no way back.
      // Typing releases history, so a palette opened by typing keeps the keys.
      if (!history.isRecalling && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
        event.preventDefault();
        setSlashIndex(
          nextSlashIndex(slashActiveIndex, slashMatches.length, event.key === 'ArrowDown' ? 1 : -1)
        );
        return;
      }
      // Tab and Enter are never history's, so they complete either way — unless
      // the highlighted name is already typed in full, where there is nothing
      // left to complete and Enter is the send the user meant. Without that,
      // finishing a name costs a second Enter, and a recalled `/deploy` cannot
      // be re-sent at all. Shift is excluded from both: Shift+Tab is how a
      // keyboard leaves the composer, and Shift+Enter is a newline.
      const chosen = slashMatches[slashActiveIndex];
      const completes = chosen !== undefined && chosen.name !== slashQuery;
      if (completes && !event.shiftKey && (event.key === 'Tab' || event.key === 'Enter')) {
        event.preventDefault();
        completeSlashCommand(chosen);
        return;
      }
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      handleSubmit(event);
      return;
    }
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;

    // ↑ enters history from the top of the box; ↓ only ever walks back out of
    // it, so it never steals the key from a caret in the middle of a prompt.
    const canRecall =
      event.key === 'ArrowUp'
        ? history.isRecalling || event.currentTarget.selectionStart === 0
        : history.isRecalling;
    if (!canRecall) return;

    const recalled = history.recall(event.key === 'ArrowUp' ? 'previous' : 'next', prompt);
    if (recalled === null) return;
    event.preventDefault();
    setPrompt(recalled);
  };

  const handleDrop = (event: DragEvent<HTMLFormElement>) => {
    event.preventDefault();
    setDragging(false);
    uploads.upload(Array.from(event.dataTransfer.files));
  };

  return (
    <footer className="shrink-0 p-3 sm:p-4 md:p-6">
      <div className="mx-auto w-full max-w-4xl">
        {externalRunnerBlocked && (
          // Named, not just disabled: "install it", "sign in", "wake that
          // machine" and "wait for discovery" are four different things to do,
          // and a composer that goes quiet without saying which leaves the user
          // clicking Send at nothing.
          <ComposerNotice tone="warning">
            {externalUnavailableReason
              ? `${t.externalAgents.unavailable[externalUnavailableReason]} — ${t.externalAgents.selector.unavailableHere}`
              : t.externalAgents.selector.unavailableHere}
          </ComposerNotice>
        )}

        {steerError && <ComposerNotice tone="error">{steerError}</ComposerNotice>}

        {uploads.error && <ComposerNotice tone="error">{uploads.error}</ComposerNotice>}

        {(pendingAttachments.length > 0 || uploads.uploading.length > 0) && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {pendingAttachments.map((attachment) => (
              <span
                key={attachment.id}
                className="flex items-center gap-1.5 rounded-full border border-outline-variant/20 bg-surface-container-lowest px-2.5 py-1 text-[11px] text-on-surface-variant"
              >
                <FileText size={12} className="composer-chip-icon shrink-0" />
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
            {uploads.uploading.map((name) => (
              <span
                key={name}
                role="status"
                className="flex items-center gap-1.5 rounded-full border border-outline-variant/20 px-2.5 py-1 text-[11px] text-on-surface-variant/70"
              >
                <span className="size-3 shrink-0 animate-spin rounded-full border border-current border-t-transparent" />
                <span className="max-w-[12rem] truncate">
                  {formatMessage(t.chat.input.attachUploading, { name })}
                </span>
              </span>
            ))}
          </div>
        )}

        <form
          onSubmit={handleSubmit}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={(event) => {
            // Moving between the form's own children fires `dragleave` on the
            // one being left; only a pointer that has actually left the form
            // should clear the highlight.
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              setDragging(false);
            }
          }}
          onDrop={handleDrop}
          data-testid="composer"
          data-dragging={dragging}
          // The whole frame reads this one property; nothing below hard-codes a
          // colour. See `lib/composer-accent.ts`.
          style={{ [COMPOSER_ACCENT_PROPERTY]: composerAccent(runner) } as CSSProperties}
          className="composer-shell shadow-2xl"
        >
          <ComposerChipRow
            {...CHIP_ROW_DEFAULTS}
            {...chipRow}
            disabled={disabled}
            isGenerating={isGenerating}
            isExternalRunner={isExternalRunner}
            activeModel={activeModel}
            selectedAgentId={selectedAgentId}
            externalDescriptor={externalDescriptor}
          />

          {/* `items-start` so the prompt mark holds the first line while the
              box grows under it, the way a shell prompt does. The padding
              moved onto this row so the two share a text box and stay on the
              same baseline. */}
          <div className="relative flex items-start gap-2 px-3 py-2.5">
            {slashOpen && (
              <SlashCommandMenu
                entries={slashMatches}
                activeIndex={slashActiveIndex}
                listId={slashListId}
                onSelect={completeSlashCommand}
                onHighlight={setSlashIndex}
              />
            )}
            <span
              aria-hidden="true"
              className={`composer-prompt-mark ${inputDisabled ? 'opacity-50' : ''}`}
            >
              ❯
            </span>
            <textarea
              ref={textareaRef}
              rows={1}
              value={prompt}
              // An editable combobox, but only while there is a popup to be
              // the combobox *of*. The rest of the time this is a multi-line
              // prompt box, and claiming a role with no listbox behind it would
              // trade the composer's real semantics for a completion that
              // covers one token of it.
              //
              // The consequence to know: a *lazy* role-based locator — a
              // Playwright `getByRole('textbox')`, not a resolved DOM node —
              // stops matching while the palette is open. Address the textarea
              // by element there.
              {...(slashOpen
                ? ({
                    role: 'combobox',
                    'aria-autocomplete': 'list',
                    'aria-expanded': true,
                    'aria-controls': slashListId,
                    ...(slashSelectable
                      ? { 'aria-activedescendant': `${slashListId}-${slashActiveIndex}` }
                      : {}),
                  } as const)
                : {})}
              onChange={(event) => {
                setPrompt(event.target.value);
                setCaret(event.target.selectionStart ?? event.target.value.length);
                // Typing is what un-dismisses the palette: Escape hides it for
                // the text it was showing over, not for the rest of the chat.
                setSlashDismissed(false);
                history.release();
                if (steerError) setSteerError(null);
                if (uploads.error) uploads.clearError();
              }}
              onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
              // A palette left open over a composer nobody is typing in is a
              // menu the keyboard cannot reach. Choosing a row does not blur:
              // the list answers `mousedown` with `preventDefault`, so focus
              // never leaves the textarea for a click inside it.
              onBlur={() => setSlashDismissed(true)}
              // The other half of that: coming back is what makes the palette
              // caret-driven rather than trigger-keyed. Without it, a trip to
              // the MCP menu and back leaves a command the user is standing in
              // the middle of with no menu until they type another character.
              onFocus={() => setSlashDismissed(false)}
              onKeyDown={handleKeyDown}
              onPaste={(event) => {
                const files = filesFromClipboard(event.clipboardData);
                if (files.length === 0) return;
                event.preventDefault();
                uploads.upload(files);
              }}
              disabled={inputDisabled}
              style={{ maxHeight: `${TEXTAREA_MAX_HEIGHT_PX}px` }}
              className="app-scrollbar composer-input min-w-0 flex-1 resize-none bg-transparent p-0 font-body text-sm leading-5 text-on-surface outline-none placeholder:text-on-surface-variant/40 disabled:opacity-60"
              placeholder={placeholder}
            />
          </div>

          <div className="flex items-end justify-between gap-2 px-2 pb-2">
            <div className="flex min-w-0 flex-wrap items-center gap-1">
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
                <ImageIntentToggle
                  active={imageToolIntent}
                  disabled={disabled}
                  onChange={onImageToolIntentChange}
                />
              )}
            </div>

            <div className="flex shrink-0 items-center gap-1">
              {isGenerating && (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={onStop}
                  title={t.chat.input.stop}
                  className={`text-xs hover:bg-error/20 hover:text-error shrink-0 ${
                    showSteerAffordance ? 'size-9 p-0' : 'h-9 gap-1.5 px-3'
                  }`}
                >
                  {!showSteerAffordance && (
                    <span className="hidden sm:inline">{t.chat.input.stop}</span>
                  )}{' '}
                  <Square size={12} />
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
                  // Steering only ever happens on a vendor CLI, so the one
                  // colour it must not be is MangoStudio's.
                  style={{ borderColor: 'var(--composer-accent)', color: 'var(--composer-accent)' }}
                  className="h-9 shrink-0 gap-1.5 rounded-full border-2 px-3.5 text-xs hover:bg-surface-container-high"
                >
                  <span className="hidden sm:inline">{t.externalAgents.steer.button}</span>{' '}
                  <CornerDownRight size={ICON_SM} className="sm:hidden" />
                  <CornerDownRight size={ICON_MD} className="hidden sm:block" />
                </Button>
              ) : !isGenerating ? (
                <Button
                  type="submit"
                  disabled={disabled || cannotSubmit || !prompt.trim()}
                  className="h-9 shrink-0 gap-1.5 rounded-full px-3.5 text-xs shadow-none hover:brightness-110 hover:opacity-100"
                  // A flat fill rather than the mango gradient: the gradient
                  // names the product, and this button belongs to whoever runs
                  // the turn. The light theme darkens it a step — see the
                  // `--composer-send-fill` rules in `index.css`.
                  style={{ background: 'var(--composer-send-fill)' }}
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
          </div>

          {dragging ? (
            <span
              aria-hidden="true"
              className="composer-drop-hint pointer-events-none absolute inset-0 flex items-center justify-center rounded-xl font-mono text-xs"
            >
              {t.chat.input.dropHint}
            </span>
          ) : null}
        </form>

        <p className="mt-2 text-center font-mono text-[10px] text-on-surface-variant/40 sm:mt-3">
          {t.common.disclaimer}
          {/* The quiet line the user should never have to guess at: MangoStudio's
              own tool settings do not apply to a turn it is not running. It sits
              here rather than in the chip row so the composer keeps only the
              controls you can act on. */}
          {isExternalRunner && externalDescriptor ? (
            <>
              {' · '}
              {formatMessage(t.externalAgents.selector.ownership, {
                vendor: t.externalAgents.target[externalDescriptor.targetId],
              })}
            </>
          ) : null}
        </p>
      </div>
    </footer>
  );
}

const NOTICE_TONE_CLASS = {
  warning: 'text-warning',
  error: 'text-error',
} as const;

/**
 * A one-line problem above the composer: the runner cannot start a turn, a
 * steer was refused, an upload failed. One component because the three read as
 * one strip and had drifted into three copies of the same class string.
 */
function ComposerNotice({
  tone,
  children,
}: {
  tone: keyof typeof NOTICE_TONE_CLASS;
  children: ReactNode;
}) {
  return (
    <p
      role="status"
      className={`mb-2 flex items-center gap-1.5 text-[11px] ${NOTICE_TONE_CLASS[tone]}`}
    >
      <AlertTriangle size={12} className="shrink-0" />
      {children}
    </p>
  );
}

/**
 * Grows the textarea with its content up to {@link TEXTAREA_MAX_HEIGHT_PX},
 * then lets it scroll.
 *
 * `scrollHeight` never reports *less* than the element's current height, so a
 * prompt that got shorter has to be reset to `auto` before it is measured —
 * otherwise the box only ever grows and deleting a paragraph leaves a tall
 * empty composer behind. Text that got *longer* needs no reset, and skipping it
 * there halves the forced layouts for ordinary forward typing, which is the
 * overwhelmingly common case on the one interaction that must stay at input
 * latency.
 */
function useAutoGrow(ref: React.RefObject<HTMLTextAreaElement | null>, value: string): void {
  const previousLength = useRef(value.length);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (value.length < previousLength.current) node.style.height = 'auto';
    previousLength.current = value.length;
    node.style.height = `${Math.min(node.scrollHeight, TEXTAREA_MAX_HEIGHT_PX)}px`;
  }, [ref, value]);
}
