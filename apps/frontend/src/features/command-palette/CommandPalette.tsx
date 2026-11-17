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
 * Two halves. `PaletteFrame` (eager) owns the input, focus and Escape;
 * `PaletteResults` (this file's lazy half) owns the ranking, the rows and the
 * navigation keys, and reads the query from the frame. `CommandPalette` joins
 * them for callers that have no reason to split.
 *
 * Presentational on purpose: it takes the registry and a close callback, so its
 * behaviour is testable without a router, a query client or the app context.
 */

import { ArrowRightToLine, ArrowUpDown, SearchX } from 'lucide-react';
import {
  type KeyboardEvent,
  memo,
  type ReactNode,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
} from 'react';

import { EmptyState } from '@/components/ui/EmptyState';
import { KbdHint, ReturnKey } from '@/components/ui/KbdHint';
import { MicroLabel } from '@/components/ui/MicroLabel';
import { Skeleton } from '@/components/ui/Skeleton';
import { StatusDot } from '@/components/ui/StatusDot';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { ICON_LG, ICON_MD, ICON_SM } from '@/lib/icon-sizes';
import { cn } from '@/lib/utils';

import type { CommandItem } from './lib/command-item';
import { activeCommandIndex, rankCommands } from './lib/match';
import { PaletteFrame, type PaletteFrameState } from './PaletteFrame';

export interface CommandPaletteProps {
  readonly items: readonly CommandItem[];
  /** True while a lazily-mounted source is still answering. */
  readonly isLoading?: boolean;
  readonly onClose: () => void;
}

export interface PaletteResultsProps extends PaletteFrameState {
  readonly items: readonly CommandItem[];
  readonly isLoading?: boolean;
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
  return (
    <PaletteFrame onClose={onClose}>
      {(frame) => <PaletteResults {...frame} items={items} isLoading={isLoading} />}
    </PaletteFrame>
  );
});

/** The ranked list and its keys; mounted inside a `PaletteFrame`. */
export const PaletteResults = memo(function PaletteResults({
  items,
  isLoading = false,
  query,
  listId,
  keyHandlerRef,
  onActiveIdChange,
}: PaletteResultsProps) {
  const { t } = useI18n();
  const labels = t.commandPalette;
  /**
   * The command id the user pinned, or null for "wherever the ranking says".
   *
   * An id rather than an offset because the list moves under a held cursor
   * while sources load: discovery finishing inserts runner rows, and a numeric
   * pin would keep its offset while the command under it changed — arming Enter
   * on a row the user never chose.
   *
   * It remembers the query it was pinned under: typing releases the cursor back
   * to the ranking, so each new query lands on its own best match rather than on
   * wherever the last one left. Keyed by query instead of cleared by the input's
   * change handler, because the input lives in the frame.
   */
  const [pin, setPin] = useState<{ readonly id: string; readonly query: string } | null>(null);
  const pinnedId = pin?.query === query ? pin.id : null;
  const setPinnedId = useCallback((id: string) => setPin({ id, query }), [query]);

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
  const safeIndex = activeCommandIndex({ groups, flat, bestIndex }, pinnedId);
  /** The active row as a movable cursor: never negative, so wrapping is honest. */
  const from = Math.max(safeIndex, 0);
  const activeItem = safeIndex >= 0 ? flat[safeIndex] : undefined;
  const activeId = activeItem ? optionId(listId, activeItem) : undefined;

  // The input is the frame's, so the highlighted row is reported up for its
  // `aria-activedescendant`.
  useEffect(() => {
    onActiveIdChange(activeId);
    return () => onActiveIdChange(undefined);
  }, [activeId, onActiveIdChange]);

  // `block: 'nearest'` so arrowing down the list scrolls by a row rather than
  // recentering on every step. Optional call: happy-dom has no layout, and a
  // missing implementation must not take the palette down in tests.
  useEffect(() => {
    if (!activeId) return;
    document.getElementById(activeId)?.scrollIntoView?.({ block: 'nearest' });
  }, [activeId]);

  // Movement pins by id even though it thinks in offsets: the offset names a
  // row in *this* ranking, and only the id survives the next one.
  const move = useCallback(
    (delta: number) => {
      if (flat.length === 0) return;
      setPinnedId(flat[(from + delta + flat.length) % flat.length].id);
    },
    [flat, from, setPinnedId]
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
      setPinnedId(flat[sectionStarts[next]].id);
    },
    [flat, sectionStarts, from, setPinnedId]
  );

  const onKeyDown = (event: KeyboardEvent) => {
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
        if (flat.length > 0) setPinnedId(flat[0].id);
        return;
      case 'End':
        event.preventDefault();
        if (flat.length > 0) setPinnedId(flat[flat.length - 1].id);
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
        // The pin comes along. Typing releases it, but the window stays open
        // afterwards: an Arrow, Home, End or Tab landing inside it pins a row
        // the user can see highlighted, and running the live query's best match
        // instead would run a command they did not choose. `activeCommandIndex`
        // resolves it against the live ranking and releases it if that ranking
        // no longer holds the row — the same rule the render uses.
        const item = query === deferredQuery ? activeItem : liveCommand(items, query, pinnedId);
        // Swallowed even with nothing to run: Enter in the palette must never
        // fall through to the page behind it.
        event.preventDefault();
        if (item) void item.run();
        return;
      }
      default:
    }
  };

  // Registered after every render so the frame always calls the handler that
  // closes over this render's ranking; cleared on unmount so the frame goes back
  // to swallowing these keys.
  useEffect(() => {
    keyHandlerRef.current = onKeyDown;
    return () => {
      keyHandlerRef.current = null;
    };
  });

  const showEmpty = !isLoading && flat.length === 0;

  return (
    <>
      <div className="app-scrollbar max-h-[55vh] min-h-0 overflow-y-auto py-2">
        <div
          id={listId}
          // eslint-disable-next-line jsx-a11y/prefer-tag-over-role -- The custom listbox renders rich options a native select cannot contain.
          role="listbox"
          aria-label={labels.title}
        >
          {groups.map((group, groupIndex) => (
            // eslint-disable-next-line jsx-a11y/prefer-tag-over-role -- `group` is the role ARIA defines for a listbox's own sections; `<fieldset>` groups form controls and is not a valid listbox child.
            <div key={group.section} role="group" aria-labelledby={`${listId}-${group.section}`}>
              <MicroLabel as="div" id={`${listId}-${group.section}`} className="px-4 pb-1 pt-2">
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
                    onActivate={() => setPinnedId(item.id)}
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
            icon={<SearchX size={ICON_LG} />}
            title={formatMessage(t.common.noResultsFor, { query: deferredQuery.trim() })}
            hint={labels.emptyHint}
          />
        ) : null}
      </div>

      {/* Keyboard hints: a touch screen has neither arrows nor Tab, so the
          footer is not drawn on a coarse pointer. The keys are icons, like
          Return: `↑↓` and `⇥` as text glyphs render hairline-thin and about
          half the size of the arrow beside them, which left the keycap
          looking empty. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-stroke px-4 py-2 text-xs text-fg-muted pointer-coarse:hidden">
        <FooterHint keys={<ArrowUpDown size={ICON_SM} />} label={labels.hints.navigate} />
        <FooterHint keys={<ReturnKey />} label={labels.hints.run} />
        <FooterHint keys={<ArrowRightToLine size={ICON_SM} />} label={labels.hints.sections} />
      </div>
    </>
  );
});

/**
 * The row a query would arm right now, ranked outside the deferred render.
 *
 * Only Enter pays for it, and only on the renders where the deferred value has
 * not caught up — which is why the list can keep deferring without Enter
 * inheriting the lag.
 */
function liveCommand(
  items: readonly CommandItem[],
  query: string,
  pinnedId: string | null
): CommandItem | undefined {
  const ranked = rankCommands(items, query);
  return ranked.flat[activeCommandIndex(ranked, pinnedId)];
}

/** Namespaced so two palettes on one page cannot collide on `id`. */
function optionId(listId: string, item: CommandItem): string {
  return `${listId}-${item.id}`;
}

function FooterHint({ keys, label }: { keys: ReactNode; label: string }) {
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
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events -- options are driven from the combobox input, where every key path is handled.
    <div
      id={id}
      // eslint-disable-next-line jsx-a11y/prefer-tag-over-role -- The custom listbox option carries rich content and selection behavior.
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
      className={cn(
        'mx-2 flex h-10 cursor-pointer items-center gap-3 rounded-sm px-2 text-sm text-fg',
        active && 'bg-fill-selected'
      )}
    >
      {Icon ? (
        <Icon
          size={ICON_MD}
          aria-hidden="true"
          className={cn('shrink-0', active ? 'text-fg' : 'text-fg-muted')}
        />
      ) : null}
      <span className="truncate">{item.label}</span>
      {/* Below `sm` the folder steps back like the timestamp does, for the same
          reason: the label is what the reader scans for. Visually only; the words
          stay in the accessibility tree and in what the search matches. */}
      {item.hint ? (
        <span
          className={cn(
            'min-w-0 shrink truncate text-xs text-fg-subtle max-sm:sr-only',
            item.hintIsPath && 'font-mono'
          )}
        >
          {item.hint}
        </span>
      ) : null}
      <span className="ml-auto flex shrink-0 items-center gap-2">
        {item.badge ? (
          <span className="flex items-center gap-1.5 font-mono text-micro text-fg-subtle">
            <StatusDot tone="neutral" className={item.badge.dotClassName} />
            {/* The dot stays: it is the harness's identity at any width. */}
            <span className="max-sm:sr-only">{item.badge.label}</span>
          </span>
        ) : null}
        {/* Hidden below `sm`, but only visually: on a 390px row the label, the
            folder and the harness badge all truncate to fight over the space, and
            the label is what the reader is scanning for. The timestamp, the folder
            above and the badge's word all step back; the words stay in the
            accessibility tree at every width. */}
        {item.meta ? (
          <span className="font-mono text-micro text-fg-subtle max-sm:sr-only">{item.meta}</span>
        ) : null}
        {item.shortcut ? <KbdHint keys={item.shortcut} /> : null}
      </span>
    </div>
  );
}
