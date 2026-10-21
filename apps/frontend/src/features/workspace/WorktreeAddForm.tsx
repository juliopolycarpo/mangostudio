import type { AddWorktreeBody } from '@mangostudio/shared/git';
import { type FormEvent, useId, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Radio } from '@/components/ui/Radio';
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
  const pathId = useId();
  const branchId = useId();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmedPath = path.trim();
    const trimmedBranch = branch.trim();
    if (!trimmedPath || !trimmedBranch) return;
    onSubmit({ path: trimmedPath, branch: trimmedBranch, mode });
  };

  return (
    <form onSubmit={submit} aria-label={labels.addTitle}>
      <Card padded={false} className="space-y-3 p-3">
        <Input
          id={pathId}
          label={labels.pathLabel}
          value={path}
          onChange={(event) => setPath(event.target.value)}
          placeholder={labels.pathPlaceholder}
          className="font-mono"
          hint={labels.pathHint}
        />

        <Input
          id={branchId}
          label={labels.branchLabel}
          value={branch}
          onChange={(event) => setBranch(event.target.value)}
          placeholder={labels.branchPlaceholder}
          className="font-mono"
        />

        <fieldset className="space-y-1">
          <legend className="mb-1 text-sm font-medium text-fg">{labels.modeLabel}</legend>
          {MODES.map((option) => (
            // biome-ignore lint/a11y/noLabelWithoutControl: the radio is a child of this label.
            <label key={option} className="flex cursor-pointer items-center gap-2 text-sm text-fg">
              <Radio
                name="worktree-branch-mode"
                value={option}
                checked={mode === option}
                onChange={() => setMode(option)}
              />
              {option === 'new-branch' ? labels.modeNew : labels.modeExisting}
            </label>
          ))}
        </fieldset>

        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" size="sm" disabled={pending} onClick={onCancel}>
            {labels.cancel}
          </Button>
          <Button type="submit" size="sm" loading={pending} disabled={pending}>
            {pending ? labels.submitting : labels.submit}
          </Button>
        </div>
      </Card>
    </form>
  );
}
