/**
 * The palette's eager shell: backdrop, dialog panel and the search input.
 *
 * The rest of the palette (the registry, ranking and rows) is a lazy chunk, so
 * the first open after a cold load waits for it. Nothing here waits: the input
 * mounts in the same commit as the open, takes focus at once and owns every key
 * until the results arrive. What was typed stays in this component's state and
 * is handed to the results as their query, so no character is lost, doubled or
 * sent to the composer behind, and an IME composition is never interrupted by a
 * swapped input element.
 *
 * The results register a key handler through `keyHandlerRef` for the navigation
 * keys (arrows, Home, End, Tab, Enter). Until one is registered those keys are
 * swallowed, so Enter cannot run anything while there is nothing to run.
 */

import { Search } from 'lucide-react';
import * as motion from 'motion/react-m';
import {
  type KeyboardEvent,
  type MutableRefObject,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';

import { DIALOG_SURFACE_CLASS } from '@/components/ui/Dialog';
import { KbdHint } from '@/components/ui/KbdHint';
import { onFocusTrapEngaged } from '@/hooks/use-focus-trap';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_MD } from '@/lib/icon-sizes';
import { useMotionPresets } from '@/lib/motion/use-motion-presets';
import { cn } from '@/lib/utils';

/** What the results do with a navigation key once they are mounted. */
export type PaletteKeyHandler = (event: KeyboardEvent) => void;

/** The shell's state, handed to whatever renders the results. */
export interface PaletteFrameState {
  /** What the input holds right now, including text typed before the results mounted. */
  readonly query: string;
  /** The listbox id the input's `aria-controls` points at. */
  readonly listId: string;
  /** The results set this on mount and clear it on unmount. */
  readonly keyHandlerRef: MutableRefObject<PaletteKeyHandler | null>;
  /** The results report the highlighted row so the input can name it. */
  readonly onActiveIdChange: (id: string | undefined) => void;
}

interface PaletteFrameProps {
  readonly onClose: () => void;
  readonly children: (state: PaletteFrameState) => ReactNode;
}

/** Keys the results own. Without results they are swallowed, never passed to the page. */
const RESULT_KEYS = new Set(['ArrowDown', 'ArrowUp', 'Home', 'End', 'Tab', 'Enter']);

export function PaletteFrame({ onClose, children }: PaletteFrameProps) {
  const { t } = useI18n();
  const labels = t.commandPalette;
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const keyHandlerRef = useRef<PaletteKeyHandler | null>(null);
  const [query, setQuery] = useState('');
  const [activeId, setActiveId] = useState<string | undefined>(undefined);
  const { dialogPanel } = useMotionPresets();

  // Focus lands on the input and stays there; where it came from is restored on
  // close, so dismissing puts the user back on the control they opened it from
  // rather than at the top of the document.
  //
  // Unless something else has taken focus by then. A row that opens another
  // overlay — the workdir picker — closes the palette and mounts the picker in
  // one batch, but `AnimatePresence` keeps this component mounted through its
  // exit animation, so this cleanup runs ~160ms *after* the picker's focus trap
  // has already focused itself. Restoring unconditionally would then pull focus
  // out of the dialog that just opened and park it on the pre-palette trigger,
  // behind a modal. The input node is captured here rather than read from the
  // ref in the cleanup: refs detach during the mutation phase, so by the time
  // this passive cleanup runs `inputRef.current` is already null.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const input = inputRef.current;
    input?.focus();
    return () => {
      const active = document.activeElement;
      // `body` (or nothing) is where a browser parks focus when the focused
      // input is removed; happy-dom leaves it on the detached input instead.
      // Both mean "still ours".
      if (active && active !== input && active !== document.body) return;
      previouslyFocused?.focus?.();
    };
  }, []);

  // A trapped dialog that opens while the palette is up takes focus and the
  // keyboard from it — an external send can raise a trust or disclosure gate at
  // any moment — but the palette paints over it at `z-[60]`, so typing would
  // stop affecting the only overlay the user can see. Yield to it. Opening the
  // palette over a gate that is *already* up is the case this must not touch,
  // and it does not: only a newly engaged trap notifies.
  useEffect(() => onFocusTrapEngaged(onClose), [onClose]);

  const onKeyDown = (event: KeyboardEvent) => {
    // An IME candidate list uses the same keys; the keystroke belongs to it.
    // Both signals, as in `isModChord`: some browsers report an active
    // composition only through the legacy `keyCode`, and there Enter would
    // commit a candidate *and* run a command.
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (!RESULT_KEYS.has(event.key)) return;
    const handler = keyHandlerRef.current;
    if (handler) {
      handler(event);
      return;
    }
    // Results still loading: nothing to move over or run.
    event.preventDefault();
  };

  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- the backdrop only dismisses; Escape on the dialog is its keyboard equivalent.
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-scrim px-4 pt-[10vh]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <motion.div
        // eslint-disable-next-line jsx-a11y/prefer-tag-over-role -- This custom dialog owns its focus and dismissal behavior.
        role="dialog"
        aria-modal="true"
        aria-label={labels.title}
        onKeyDown={onKeyDown}
        // The input is the only focusable node in the panel, so a press on any
        // other part of it — a heading, the footer hints, the padding beside the
        // input — would hand focus to `document.body`. `body` is an ancestor of
        // this element, so every later keystroke would bypass `onKeyDown` and
        // the palette would go dead to the keyboard until the input was clicked
        // again. Suppressing the default focus move keeps the caret where every
        // key path here expects it.
        onMouseDown={(event) => {
          if (event.target !== inputRef.current) event.preventDefault();
        }}
        {...dialogPanel}
        className={cn('flex w-full max-w-2xl flex-col overflow-hidden', DIALOG_SURFACE_CLASS)}
        data-testid="command-palette"
      >
        <div className="flex h-12 items-center gap-3 border-b border-stroke px-4">
          <Search size={ICON_MD} aria-hidden="true" className="shrink-0 text-fg-muted" />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={activeId}
            aria-label={labels.title}
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={labels.placeholder}
            className="min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-fg-subtle"
          />
          <KbdHint keys={labels.keys.escape} />
        </div>
        {children({ query, listId, keyHandlerRef, onActiveIdChange: setActiveId })}
      </motion.div>
    </div>
  );
}
