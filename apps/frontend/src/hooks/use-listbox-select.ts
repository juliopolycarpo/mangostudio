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
  readonly disabled?: boolean;
}

interface Params<Option extends ListboxOption> {
  readonly value: string;
  readonly options: readonly Option[];
  readonly onChange: (value: string) => void;
  readonly disabled?: boolean;
}

export interface ListboxSelect<Option extends ListboxOption> {
  readonly open: boolean;
  readonly setOpen: Dispatch<SetStateAction<boolean>>;
  readonly activeIndex: number;
  readonly setActiveIndex: Dispatch<SetStateAction<number>>;
  /** Attach to the element wrapping trigger and panel — closes on outside click. */
  readonly containerRef: React.RefObject<HTMLDivElement | null>;
  readonly selected: Option | undefined;
  readonly selectedIndex: number;
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

  const selected = options.find((option) => option.value === value);
  const selectedIndex = options.findIndex((option) => option.value === value);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [open]);

  // A list that changes under a closed menu — a catalog refetch between two
  // openings — must not leave the cursor pointing at whatever now sits at that
  // index, so each opening starts from the selection instead.
  useEffect(() => {
    if (!open) setActiveIndex(-1);
  }, [open]);

  const commit = (option: Option) => {
    if (option.disabled) return;
    setOpen(false);
    if (option.value !== value) onChange(option.value);
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

    if (!open) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter') {
        event.preventDefault();
        setOpen(true);
        setActiveIndex(selectedIndex >= 0 ? selectedIndex : step(-1, 1));
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
    setOpen,
    activeIndex,
    setActiveIndex,
    containerRef,
    selected,
    selectedIndex,
    commit,
    handleKeyDown,
  };
}
