/**
 * The `/` palette: a listbox over the composer, driven entirely by its props.
 *
 * Stateless on purpose. The composer owns the query, the highlight and the
 * keyboard, because those are all functions of the textarea's value and caret —
 * splitting them across two components is how a palette ends up completing
 * against a prompt the user has already changed.
 */

import { useEffect, useRef } from 'react';
import { useI18n } from '@/hooks/use-i18n';
import type { SlashCommandEntry } from '../lib/slash-commands';

interface Props {
  readonly entries: readonly SlashCommandEntry[];
  readonly activeIndex: number;
  readonly listId: string;
  readonly onSelect: (entry: SlashCommandEntry) => void;
  /** Keeps the highlight from following the pointer while the keyboard drives. */
  readonly onHighlight: (index: number) => void;
}

export function SlashCommandMenu({ entries, activeIndex, listId, onSelect, onHighlight }: Props) {
  const { t } = useI18n();
  const labels = t.chat.input;
  const activeRef = useRef<HTMLDivElement>(null);

  // Arrow keys can walk the highlight past the visible window, and a selection
  // the user cannot see is the same as no selection. Keyed on the index rather
  // than run once: on mount the highlight is always the first row, which is the
  // one case that needed no scrolling.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  // An empty listbox rather than a bare panel: the composer points
  // `aria-controls` at this id whenever the palette is open, and "no match" is
  // the state it is open in most often. A panel without the id and the role
  // would make that reference dangle exactly then.
  if (entries.length === 0) {
    return (
      <div
        id={listId}
        role="listbox"
        tabIndex={-1}
        aria-label={labels.slashMenuLabel}
        className="absolute bottom-full left-0 z-40 mb-2 w-80 rounded-2xl border border-outline-variant/20 bg-surface-container-high p-3 shadow-2xl"
      >
        <p className="text-xs text-on-surface-variant/70">{labels.slashMenuEmpty}</p>
      </div>
    );
  }

  return (
    <div
      id={listId}
      // The composer keeps focus throughout, so the list is driven entirely
      // through `aria-activedescendant` on the textarea. `tabIndex={-1}` makes
      // it a legal listbox without ever putting it in the tab order — nothing
      // here is reachable by Tab, which the composer spends on completion.
      role="listbox"
      tabIndex={-1}
      aria-label={labels.slashMenuLabel}
      className="app-scrollbar absolute bottom-full left-0 z-40 mb-2 max-h-72 w-80 overflow-y-auto rounded-2xl border border-outline-variant/20 bg-surface-container-high p-1 shadow-2xl"
    >
      {entries.map((entry, index) => (
        <div
          key={entry.name}
          ref={index === activeIndex ? activeRef : undefined}
          id={`${listId}-${index}`}
          role="option"
          tabIndex={-1}
          aria-selected={index === activeIndex}
          // `mousedown` rather than `click`: the composer must not lose focus
          // between the press and the completion, or the caret restored
          // afterwards points into a textarea nobody is typing in.
          onMouseDown={(event) => {
            event.preventDefault();
            onSelect(entry);
          }}
          onMouseEnter={() => onHighlight(index)}
          className={`flex cursor-pointer flex-col gap-0.5 rounded-xl px-2.5 py-1.5 text-left ${
            index === activeIndex ? 'bg-surface-container-highest' : 'hover:bg-surface-container'
          }`}
        >
          <span className="flex items-baseline gap-2">
            <span className="font-mono text-xs text-on-surface">/{entry.name}</span>
            <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wide text-on-surface-variant/60">
              {labels.slashMenuOrigin[entry.origin]}
            </span>
          </span>
          {entry.description && (
            <span className="line-clamp-2 text-[11px] text-on-surface-variant">
              {entry.description}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
