import type { AddWorktreeBody } from '@mangostudio/shared/git';
import { type FormEvent, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useI18n } from '@/hooks/use-i18n';
import type { AddWorktreeInput } from './hooks/use-git-state';

type WorktreeMode = AddWorktreeBody['mode'];

const MODES = ['new-branch', 'existing-branch'] as const satisfies readonly WorktreeMode[];

/**
 * The `git worktree add` form: a target directory, a branch, and which of the
 * two commands to run.
 *
 * The submit handler is a parameter rather than a mutation this component
 * owns, so the section above it keeps the single view of what is in flight.
 *
 * @example
 * <WorktreeAddForm pending={false} onSubmit={add} onCancel={close} />
 */
export function WorktreeAddForm({
  pending,
  onSubmit,
  onCancel,
}: {
  readonly pending: boolean;
  readonly onSubmit: (input: AddWorktreeInput) => void;
  readonly onCancel: () => void;
}) {
  const { t } = useI18n();
  const labels = t.git.worktrees;
  const [path, setPath] = useState('');
  const [branch, setBranch] = useState('');
  const [mode, setMode] = useState<WorktreeMode>('new-branch');

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmedPath = path.trim();
    const trimmedBranch = branch.trim();
    if (!trimmedPath || !trimmedBranch) return;
    onSubmit({ path: trimmedPath, branch: trimmedBranch, mode });
  };

  return (
    <form
      onSubmit={submit}
      aria-label={labels.addTitle}
      className="space-y-2.5 rounded-xl border border-outline-variant/15 bg-surface-container-lowest/40 p-2.5"
    >
      <label className="block space-y-1">
        <span className="text-[10px] font-semibold text-on-surface-variant">
          {labels.pathLabel}
        </span>
        <input
          value={path}
          onChange={(event) => setPath(event.target.value)}
          placeholder={labels.pathPlaceholder}
          className="w-full rounded-lg border border-outline-variant/20 bg-surface-container-lowest px-2.5 py-1.5 font-mono text-[11px] text-on-surface outline-none transition-colors placeholder:text-on-surface-variant/50 focus:border-primary/60"
        />
      </label>
      <p className="text-[10px] leading-4 text-on-surface-variant/70">{labels.pathHint}</p>

      <label className="block space-y-1">
        <span className="text-[10px] font-semibold text-on-surface-variant">
          {labels.branchLabel}
        </span>
        <input
          value={branch}
          onChange={(event) => setBranch(event.target.value)}
          placeholder={labels.branchPlaceholder}
          className="w-full rounded-lg border border-outline-variant/20 bg-surface-container-lowest px-2.5 py-1.5 font-mono text-[11px] text-on-surface outline-none transition-colors placeholder:text-on-surface-variant/50 focus:border-primary/60"
        />
      </label>

      <fieldset className="space-y-1">
        <legend className="text-[10px] font-semibold text-on-surface-variant">
          {labels.modeLabel}
        </legend>
        {MODES.map((option) => (
          <label
            key={option}
            className="flex cursor-pointer items-center gap-2 text-[11px] text-on-surface-variant"
          >
            <input
              type="radio"
              name="worktree-branch-mode"
              value={option}
              checked={mode === option}
              onChange={() => setMode(option)}
              className="accent-primary"
            />
            {option === 'new-branch' ? labels.modeNew : labels.modeExisting}
          </label>
        ))}
      </fieldset>

      <div className="flex gap-1.5">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="flex-1"
          disabled={pending}
          onClick={onCancel}
        >
          {labels.cancel}
        </Button>
        <Button type="submit" size="sm" className="flex-1" loading={pending} disabled={pending}>
          {pending ? labels.submitting : labels.submit}
        </Button>
      </div>
    </form>
  );
}
