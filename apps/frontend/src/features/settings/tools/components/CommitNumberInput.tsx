import { useState } from 'react';

import { Input } from '@/components/ui/Input';

interface CommitNumberInputProps {
  id: string;
  value: number | '';
  onCommit: (value: number) => void;
  min?: number;
  max?: number;
  disabled?: boolean;
  normalize?: (value: number) => number;
}

/**
 * Keep a number draft local until blur or Enter. Escape restores the committed value.
 *
 * @example
 * <CommitNumberInput id="timeout" value={30} min={5} onCommit={saveTimeout} />
 */
export function CommitNumberInput({
  id,
  value,
  onCommit,
  min,
  max,
  disabled,
  normalize,
}: CommitNumberInputProps) {
  const [draft, setDraft] = useState<string>();

  const commit = () => {
    setDraft(undefined);
    if (disabled || draft === undefined || draft.trim() === '') return;
    const number = Number(draft);
    if (!Number.isFinite(number)) return;
    const next = normalize?.(number) ?? number;
    if (min !== undefined && next < min) return;
    if (max !== undefined && next > max) return;
    if (next !== value) onCommit(next);
  };

  return (
    <Input
      id={id}
      type="number"
      min={min}
      max={max}
      step={1}
      value={draft ?? value}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commit();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          setDraft(undefined);
        }
      }}
      disabled={disabled}
      className="w-32 text-center"
    />
  );
}
