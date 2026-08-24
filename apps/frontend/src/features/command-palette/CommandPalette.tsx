/**
 * The ⌘K overlay itself: a combobox over one flat, section-grouped list.
 *
 * Custom rather than `cmdk` — that package would drag `@radix-ui/react-dialog`
 * into a deliberately Radix-free app to solve a problem that is one input, one
 * listbox and a scorer.
 *
 * The a11y contract is the combobox one, not the dialog one: focus never leaves
 * the input, the active row is announced through `aria-activedescendant`, and
 * the rows are `role="option"` divs rather than buttons — a tab ring through
 * three hundred sessions is not navigation, it is a trap with extra steps. Tab
 * is repurposed to jump between section headings, which is what a keyboard user
 * actually wants from a grouped list, and is also what keeps focus inside: no
 * key path here yields it back to the page underneath.
 *
 * Presentational on purpose: it takes the registry and a close callback, so its
 * behaviour is testable without a router, a query client or the app context.
 */

import { Search, SearchX } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { KbdHint } from '@/components/ui/KbdHint';
import { MicroLabel } from '@/components/ui/MicroLabel';
import { Skeleton } from '@/components/ui/Skeleton';
import { StatusDot } from '@/components/ui/StatusDot';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { ICON_MD, ICON_SM } from '@/lib/icon-sizes';
import type { CommandItem } from './lib/command-item';
import { activeCommandIndex, rankCommands } from './lib/match';

export interface CommandPaletteProps {
  readonly items: readonly CommandItem[];
  /** True while a lazily-mounted source is still answering. */
  readonly isLoading?: boolean;
  readonly onClose: () => void;
}

/**
 * Memoized because its parent is a context consumer: `useCommandRegistry` reads
 * the shell, which re-renders once per streamed token while a turn is running.
 * A stable `items` alone would not stop that — the palette would still re-render
 * and rerank the whole list per token with nothing about it changed.
 */
export const CommandPalette = memo(function CommandPalette({
  items,
  isLoading = false,
  onClose,
}: CommandPaletteProps) {
  const { t } = useI18n();
  const labels = t.commandPalette;
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  /** Null until the user picks a row themselves; see `resolvedIndex` below. */
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const reduceMotion = useReducedMotion();

  // Deferred for the same reason the sidebar's search is: every keystroke
  // rescores the whole registry, and the input must not wait for it.
  const deferredQuery = useDeferredValue(query);

  const { groups, flat, bestIndex, sectionStarts } = useMemo(() => {
    const ranked = rankCommands(items, deferredQuery);
    const starts: number[] = [];
    let offset = 0;
    for (const group of ranked.groups) {
      starts.push(offset);
      offset += group.items.length;
    }
    return { ...ranked, sectionStarts: starts };
  }, [items, deferredQuery]);

  // `null` means "wherever the ranking says", so a fresh query lands on the best
  // match anywhere rather than on the first row of the first section. Arrowing
  // or hovering pins it, and typing again releases it.
  const safeIndex = activeCommandIndex({ groups, flat, bestIndex }, activeIndex);
  /** The active row as a movable cursor: never negative, so wrapping is honest. */
  const from = Math.max(safeIndex, 0);
  const activeItem = safeIndex >= 0 ? flat[safeIndex] : undefined;
  const activeId = activeItem ? optionId(listId, activeItem) : undefined;

  // Focus lands on the input and stays there; where it came from is restored on
  // close, so dismissing puts the user back on the control they opened it from
  // rather than at the top of the document.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    return () => previouslyFocused?.focus?.();
  }, []);

  // `block: 'nearest'` so arrowing down the list scrolls by a row rather than
  // recentering on every step. Optional call: happy-dom has no layout, and a
  // missing implementation must not take the palette down in tests.
  useEffect(() => {
    if (!activeId) return;
    document.getElementById(activeId)?.scrollIntoView?.({ block: 'nearest' });
  }, [activeId]);

  const move = useCallback(
    (delta: number) => {
      if (flat.length === 0) return;
      setActiveIndex((from + delta + flat.length) % flat.length);
    },
    [flat.length, from]
  );

  /** First row of the section after (or before) the active one. */
  const moveSection = useCallback(
    (delta: number) => {
      if (sectionStarts.length === 0) return;
      let current = 0;
      for (const [index, start] of sectionStarts.entries()) {
        if (start <= from) current = index;
      }
      const next = (current + delta + sectionStarts.length) % sectionStarts.length;
      setActiveIndex(sectionStarts[next]);
    },
    [sectionStarts, from]
  );

  const onKeyDown = (event: React.KeyboardEvent) => {
    // An IME candidate list uses the same keys; the keystroke belongs to it.
    if (event.nativeEvent.isComposing) return;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        move(1);
        return;
      case 'ArrowUp':
        event.preventDefault();
        move(-1);
        return;
      case 'Home':
        event.preventDefault();
        setActiveIndex(0);
        return;
      case 'End':
        event.preventDefault();
        setActiveIndex(Math.max(flat.length - 1, 0));
        return;
      case 'Tab':
        event.preventDefault();
        moveSection(event.shiftKey ? -1 : 1);
        return;
      case 'Enter': {
        // The rendered list belongs to `deferredQuery`, which lags on purpose.
        // On the committed render where the input already shows the new query
        // and the ranking still describes the old one, running what is
        // highlighted would run the *previous* query's best match — typing a
        // route and pressing Enter straight away would open the latest session
        // instead. Enter is one keystroke, not one per character, so it can
        // afford the rescore the list is deferring.
        //
        // The cursor is dropped rather than carried across: it indexes the
        // stale list, so it names a different row in the fresh one. The best
        // match for what was actually typed is the row the palette is about to
        // highlight anyway — and typing releases the cursor to it regardless.
        const item = query === deferredQuery ? activeItem : liveBestCommand(items, query);
        if (!item) return;
        event.preventDefault();
        void item.run();
        return;
      }
      case 'Escape':
        event.preventDefault();
        onClose();
        return;
      default:
    }
  };

  const showEmpty = !isLoading && flat.length === 0;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the backdrop only dismisses; Escape on the dialog is its keyboard equivalent.
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-background/70 px-4 pt-[10vh] backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <motion.div
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
        initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: -8 }}
        animate={reduceMotion ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
        exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.98, y: -4 }}
        transition={{ duration: reduceMotion ? 0.12 : 0.16, ease: [0.2, 0, 0, 1] }}
        className="flex w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-outline-variant/20 bg-surface-container-highest shadow-2xl"
        data-testid="command-palette"
      >
        <div className="flex items-center gap-3 border-b border-outline-variant/15 px-4 py-3">
          <Search
            size={ICON_MD}
            aria-hidden="true"
            className="shrink-0 text-on-surface-variant/60"
          />
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
            onChange={(event) => {
              setQuery(event.target.value);
              // Releases the cursor back to the ranking, so each new query lands
              // on its own best match rather than on wherever the last one left.
              setActiveIndex(null);
            }}
            placeholder={labels.placeholder}
            className="min-w-0 flex-1 bg-transparent text-sm text-on-surface outline-none placeholder:text-on-surface-variant/50"
          />
          <KbdHint keys="Esc" />
        </div>

        <div className="app-scrollbar max-h-[55vh] min-h-0 overflow-y-auto py-2">
          <div id={listId} role="listbox" aria-label={labels.title}>
            {groups.map((group, groupIndex) => (
              // biome-ignore lint/a11y/useSemanticElements: `group` is the role ARIA defines for a listbox's own sections; `<fieldset>` groups form controls and is not a valid listbox child.
              <div key={group.section} role="group" aria-labelledby={`${listId}-${group.section}`}>
                <MicroLabel
                  as="div"
                  id={`${listId}-${group.section}`}
                  className="px-4 pb-1 pt-2 text-on-surface-variant/60"
                >
                  {labels.sections[group.section]}
                </MicroLabel>
                {group.items.map((item, itemIndex) => {
                  const index = sectionStarts[groupIndex] + itemIndex;
                  return (
                    <CommandRow
                      key={item.id}
                      id={optionId(listId, item)}
                      item={item}
                      active={index === safeIndex}
                      onActivate={() => setActiveIndex(index)}
                    />
                  );
                })}
              </div>
            ))}
          </div>

          {isLoading ? (
            <div className="space-y-2 px-4 py-3" data-testid="command-palette-skeleton">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-4 w-1/2" />
            </div>
          ) : null}

          {showEmpty ? (
            <EmptyState
              icon={<SearchX size={20} />}
              title={formatMessage(t.common.noResultsFor, { query: deferredQuery.trim() })}
              hint={labels.emptyHint}
            />
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-outline-variant/15 px-4 py-2 text-[11px] text-on-surface-variant/60">
          <FooterHint keys="↑↓" label={labels.hints.navigate} />
          <FooterHint keys="⏎" label={labels.hints.run} />
          <FooterHint keys="⇥" label={labels.hints.sections} />
        </div>
      </motion.div>
    </div>
  );
});

/**
 * The row a query would arm right now, ranked outside the deferred render.
 *
 * Only Enter pays for it, and only on the renders where the deferred value has
 * not caught up — which is why the list can keep deferring without Enter
 * inheriting the lag.
 */
function liveBestCommand(items: readonly CommandItem[], query: string): CommandItem | undefined {
  const ranked = rankCommands(items, query);
  return ranked.flat[activeCommandIndex(ranked, null)];
}

/** Namespaced so two palettes on one page cannot collide on `id`. */
function optionId(listId: string, item: CommandItem): string {
  return `${listId}-${item.id}`;
}

function FooterHint({ keys, label }: { keys: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <KbdHint keys={keys} />
      {label}
    </span>
  );
}

function CommandRow({
  id,
  item,
  active,
  onActivate,
}: {
  id: string;
  item: CommandItem;
  active: boolean;
  onActivate: () => void;
}) {
  const Icon = item.icon;
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: options are driven from the combobox input, where every key path is handled.
    <div
      id={id}
      role="option"
      aria-selected={active}
      // Script-focusable, never tab-focusable: the input keeps DOM focus and
      // points here through `aria-activedescendant`, which is the whole reason
      // three hundred rows do not become three hundred tab stops.
      tabIndex={-1}
      // Pointer hover moves the selection so mouse and keyboard cannot disagree
      // about which row Enter would run.
      onMouseMove={onActivate}
      onClick={() => void item.run()}
      className={`mx-2 flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2 text-sm ${
        active ? 'bg-primary/10 text-on-surface' : 'text-on-surface/80'
      }`}
    >
      {Icon ? (
        <Icon
          size={ICON_SM}
          aria-hidden="true"
          className={`shrink-0 ${active ? 'text-primary' : 'text-on-surface-variant/70'}`}
        />
      ) : null}
      <span className="truncate">{item.label}</span>
      {item.hint ? (
        <span className="min-w-0 shrink truncate font-mono text-xs text-on-surface-variant/50">
          {item.hint}
        </span>
      ) : null}
      <span className="ml-auto flex shrink-0 items-center gap-2">
        {item.badge ? (
          <span className="micro-label flex items-center gap-1.5 normal-case tracking-normal">
            <StatusDot tone="neutral" className={item.badge.dotClassName} />
            {item.badge.label}
          </span>
        ) : null}
        {/* Hidden below `sm`, but only visually: on a 390px row the label, the
            folder and the harness badge all truncate to fight over the space a
            timestamp is taking, and the label is what the reader is scanning
            for. The words stay in the accessibility tree at every width. */}
        {item.meta ? (
          <span className="text-[11px] text-on-surface-variant/50 max-sm:sr-only">{item.meta}</span>
        ) : null}
        {item.shortcut ? <KbdHint keys={item.shortcut} /> : null}
      </span>
    </div>
  );
}
