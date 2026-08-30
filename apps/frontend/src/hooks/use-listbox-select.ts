/**
 * The open/cursor/commit machinery behind a one-of-many popup picker.
 *
 * `ChipSelect` grew this first, for the composer's status strip. The settings
 * forms need the same control in a different dialect — full width, form
 * tokens, opening downward — and the part worth sharing is not the markup but
 * the hundred lines of keyboard handling underneath it: skip-disabled
 * arrowing, Home/End, Escape that stops short of the surrounding dialog, and
 * a cursor that resets to the selection each time the list opens.
 *
 * The hook owns state and events; each component owns its own DOM, because the
 * two dialects share no classes and a `variant` prop threaded through every
 * element is a worse seam than two render bodies.
 *
 * Usage:
 *   const list = useListboxSelect({ value, options, onChange, disabled });
 *   <div ref={list.containerRef} onKeyDown={list.handleKeyDown}>…</div>
 */

import {
  type Dispatch,
  type KeyboardEvent,
  type SetStateAction,
  useEffect,
  useRef,
  useState,
} from 'react';

export interface ListboxOption {
  readonly value: string;
  /** What the row reads as, and what typeahead searches. */
  readonly label: string;
  readonly disabled?: boolean;
}

/** How long a typed run stays one search before the next key starts a new one. */
const TYPEAHEAD_WINDOW_MS = 500;

interface Params<Option extends ListboxOption> {
  readonly value: string;
  readonly options: readonly Option[];
  readonly onChange: (value: string) => void;
  readonly disabled?: boolean;
}

export interface ListboxSelect<Option extends ListboxOption> {
  readonly open: boolean;
  readonly activeIndex: number;
  readonly setActiveIndex: Dispatch<SetStateAction<number>>;
  /** Attach to the element wrapping trigger and panel — closes on outside click. */
  readonly containerRef: React.RefObject<HTMLDivElement | null>;
  /**
   * Attach to a panel rendered outside `containerRef` — a portal, say — so a
   * click on one of its rows still counts as inside. Leave unattached when the
   * panel is a descendant of the container.
   */
  readonly panelRef: React.RefObject<HTMLDivElement | null>;
  readonly selected: Option | undefined;
  /** The trigger's click handler: opens with the cursor on the selection, or closes. */
  readonly toggle: () => void;
  readonly commit: (option: Option) => void;
  readonly handleKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}

export function useListboxSelect<Option extends ListboxOption>({
  value,
  options,
  onChange,
  disabled = false,
}: Params<Option>): ListboxSelect<Option> {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const typeahead = useRef({ query: '', at: 0 });

  const selected = options.find((option) => option.value === value);
  const selectedIndex = options.findIndex((option) => option.value === value);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: MouseEvent) {
      const target = event.target as Node;
      // A portaled panel is not a descendant of the container, so without the
      // second test the press that chooses a row would close the list before
      // the click that commits it ever lands.
      if (containerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [open]);

  // A list that changes under a closed menu — a catalog refetch between two
  // openings — must not leave the cursor pointing at whatever now sits at that
  // index, so each opening starts from the selection instead.
  useEffect(() => {
    if (open) return;
    setActiveIndex(-1);
    // So reopening within the typeahead window starts a fresh search rather
    // than appending to the run that was interrupted.
    typeahead.current = { query: '', at: 0 };
  }, [open]);

  const commit = (option: Option) => {
    if (option.disabled) return;
    setOpen(false);
    if (option.value !== value) onChange(option.value);
  };

  /**
   * The index a typed run names, or -1 when nothing matches.
   *
   * A run of one repeated character means "the next option starting with it",
   * which is how a native select cycles same-initial entries. Anything longer
   * is a word being spelled out, so the search restarts from the current row
   * rather than skipping the match already under the cursor.
   */
  const findByTypeahead = (key: string): number => {
    const now = Date.now();
    const expired = now - typeahead.current.at > TYPEAHEAD_WINDOW_MS;
    const query = (expired ? '' : typeahead.current.query) + key;
    typeahead.current = { query, at: now };

    const cycling = [...query].every((character) => character === query[0]);
    const needle = (cycling ? key : query).toLowerCase();
    const from = activeIndex >= 0 ? activeIndex : selectedIndex;
    const start = cycling ? from + 1 : from;

    const count = options.length;
    for (let offset = 0; offset < count; offset += 1) {
      const index = (((start + offset) % count) + count) % count;
      const option = options[index];
      if (option && !option.disabled && option.label.toLowerCase().startsWith(needle)) return index;
    }
    return -1;
  };

  /** Skips disabled entries, so arrowing never parks on one that cannot be chosen. */
  const step = (from: number, direction: 1 | -1): number => {
    const count = options.length;
    if (count === 0) return -1;
    for (let offset = 1; offset <= count; offset += 1) {
      const next = (((from + direction * offset) % count) + count) % count;
      if (!options[next]?.disabled) return next;
    }
    return -1;
  };

  /** Opens with the cursor already on the current selection, as a popup does. */
  const openWithCursor = () => {
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : step(-1, 1));
    setOpen(true);
  };

  /**
   * What the trigger's click does.
   *
   * Opening this way used to leave the cursor nowhere, which on a list longer
   * than the panel meant the selected row could be scrolled out of sight the
   * moment it appeared — the keyboard path seeded the cursor and the pointer
   * path did not.
   */
  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    openWithCursor();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (disabled) return;

    if (event.key === 'Escape') {
      if (!open) return;
      // The picker may live inside a dialog that also closes on Escape; the
      // innermost layer is the one the user meant to dismiss.
      event.stopPropagation();
      event.preventDefault();
      setOpen(false);
      return;
    }

    // Tab moves focus off the trigger, and the panel is anchored to a trigger
    // the user has left: without this it stays open, floating over the page,
    // with `aria-activedescendant` still pointing at a row nothing can reach.
    // No `preventDefault` — the focus move itself is what the user asked for.
    if (event.key === 'Tab') {
      if (open) setOpen(false);
      return;
    }

    // The typeahead a native `<select>` had. Without it the only keyboard route
    // into a forty-model picker is holding ArrowDown, and typing `g` — which
    // used to jump to the first `g` model — does nothing at all.
    //
    // Space is the exception: it joins a run already in progress, so a label
    // with a space in it can be spelled, but on its own it still commits.
    const printable = event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
    const spellingSpace =
      event.key === ' ' &&
      typeahead.current.query !== '' &&
      Date.now() - typeahead.current.at <= TYPEAHEAD_WINDOW_MS;
    if (printable && (event.key !== ' ' || spellingSpace)) {
      event.preventDefault();
      const match = findByTypeahead(event.key);
      if (match < 0) return;
      // Open, this only moves the cursor and Enter still decides. Closed, a
      // native select changes the value outright, and every field behind one of
      // these debounces its write, so a spelled-out run costs one save.
      if (open) {
        setActiveIndex(match);
        return;
      }
      const option = options[match];
      if (option) commit(option);
      return;
    }

    if (!open) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter') {
        event.preventDefault();
        openWithCursor();
      }
      return;
    }

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const from = activeIndex >= 0 ? activeIndex : selectedIndex;
      setActiveIndex(step(from, event.key === 'ArrowDown' ? 1 : -1));
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      setActiveIndex(event.key === 'Home' ? step(-1, 1) : step(options.length, -1));
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const option = options[activeIndex];
      if (option) commit(option);
      else setOpen(false);
    }
  };

  return {
    open,
    activeIndex,
    setActiveIndex,
    containerRef,
    panelRef,
    selected,
    toggle,
    commit,
    handleKeyDown,
  };
}
