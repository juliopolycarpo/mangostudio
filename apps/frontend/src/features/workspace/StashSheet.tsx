import type { StashEntry } from '@mangostudio/shared/git';
import { ArchiveRestore, Copy, Trash2, X } from 'lucide-react';
import { type ReactNode, useState } from 'react';

import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Checkbox } from '@/components/ui/Checkbox';
import { Dialog } from '@/components/ui/Dialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { Spinner } from '@/components/ui/Spinner';
import { useToast } from '@/components/ui/Toast';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_MD, ICON_SM } from '@/lib/icon-sizes';
import { resolveApiErrorMessage } from '@/lib/utils';

import { DialogCodeBlock } from './components/DialogBlocks';
import { IconButton } from './components/IconButton';
import { RowList } from './components/RowList';
import {
  useGitStashes,
  useStashApply,
  useStashDrop,
  useStashPop,
  useStashSave,
} from './hooks/use-git-state';

/** The stash stack, moved off the panel body into a modal opened from the overflow menu. */
export function StashSheet({
  chatId,
  onClose,
}: {
  readonly chatId: string;
  readonly onClose: () => void;
}) {
  const { t } = useI18n();
  const { toast } = useToast();
  const labels = t.git.stash;
  const stashesQuery = useGitStashes(chatId);
  const saveMutation = useStashSave(chatId);
  const popMutation = useStashPop(chatId);
  const applyMutation = useStashApply(chatId);
  const dropMutation = useStashDrop(chatId);
  const [message, setMessage] = useState('');
  const [includeUntracked, setIncludeUntracked] = useState(false);
  const [dropRequest, setDropRequest] = useState<StashEntry | null>(null);
  const pending =
    saveMutation.isPending ||
    popMutation.isPending ||
    applyMutation.isPending ||
    dropMutation.isPending;

  const save = async () => {
    try {
      await saveMutation.mutateAsync({ message: message.trim(), includeUntracked });
      setMessage('');
      setIncludeUntracked(false);
      toast(labels.saveSuccess, 'success');
    } catch (error) {
      toast(resolveApiErrorMessage(error, labels.actionError), 'error');
    }
  };

  const restore = async (mode: 'pop' | 'apply', index: number) => {
    try {
      if (mode === 'pop') await popMutation.mutateAsync({ index });
      else await applyMutation.mutateAsync({ index });
      toast(mode === 'pop' ? labels.popSuccess : labels.applySuccess, 'success');
    } catch (error) {
      toast(resolveApiErrorMessage(error, labels.actionError), 'error');
    }
  };

  const confirmDrop = async () => {
    if (!dropRequest) return;
    try {
      await dropMutation.mutateAsync({ index: dropRequest.index });
      setDropRequest(null);
      toast(labels.dropSuccess, 'success');
    } catch (error) {
      toast(resolveApiErrorMessage(error, labels.actionError), 'error');
    }
  };

  return (
    <>
      <Dialog
        title={labels.title}
        onClose={onClose}
        headerAction={
          <IconButton label={labels.close} onClick={onClose}>
            <X size={ICON_MD} />
          </IconButton>
        }
      >
        <div className="space-y-3">
          <Input
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            aria-label={labels.messageLabel}
            placeholder={labels.messagePlaceholder}
          />
          <label className="flex cursor-pointer items-center gap-2 text-sm text-fg">
            <Checkbox
              checked={includeUntracked}
              onChange={(event) => setIncludeUntracked(event.target.checked)}
            />
            {labels.includeUntracked}
          </label>
          <Button
            type="button"
            variant="secondary"
            className="w-full"
            loading={saveMutation.isPending}
            disabled={pending}
            onClick={() => void save()}
          >
            {saveMutation.isPending ? labels.saving : labels.save}
          </Button>
        </div>

        {stashesQuery.isLoading ? (
          <EmptyState icon={<Spinner />} title={labels.loading} className="min-h-24" />
        ) : stashesQuery.error ? (
          <Callout tone="danger" title={labels.loadError} />
        ) : stashesQuery.data?.stashes.length ? (
          <RowList>
            {stashesQuery.data.stashes.map((stash) => (
              <li key={stash.index} className="space-y-2 p-3">
                <div className="min-w-0">
                  <p className="break-words text-sm font-medium text-fg">{stash.message}</p>
                  {stash.branch ? (
                    <p className="truncate font-mono text-micro text-fg-subtle">{stash.branch}</p>
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-2">
                  <StashAction
                    label={labels.applyLabel.replace('{message}', stash.message)}
                    text={labels.apply}
                    icon={<Copy size={ICON_SM} />}
                    disabled={pending}
                    onClick={() => void restore('apply', stash.index)}
                  />
                  <StashAction
                    label={labels.popLabel.replace('{message}', stash.message)}
                    text={labels.pop}
                    icon={<ArchiveRestore size={ICON_SM} />}
                    disabled={pending}
                    onClick={() => void restore('pop', stash.index)}
                  />
                  <StashAction
                    label={labels.dropLabel.replace('{message}', stash.message)}
                    text={labels.drop}
                    icon={<Trash2 size={ICON_SM} />}
                    tone="danger"
                    disabled={pending}
                    onClick={() => setDropRequest(stash)}
                  />
                </div>
              </li>
            ))}
          </RowList>
        ) : (
          <EmptyState title={labels.empty} className="min-h-24" />
        )}
      </Dialog>

      {dropRequest ? (
        <Dialog
          size="sm"
          title={labels.dropTitle}
          description={labels.dropHint}
          onClose={() => setDropRequest(null)}
          footer={
            <>
              <Button type="button" variant="secondary" onClick={() => setDropRequest(null)}>
                {labels.dropCancel}
              </Button>
              <Button
                type="button"
                variant="danger"
                loading={dropMutation.isPending}
                onClick={() => void confirmDrop()}
              >
                {labels.dropConfirm}
              </Button>
            </>
          }
        >
          <DialogCodeBlock className="break-words">{dropRequest.message}</DialogCodeBlock>
        </Dialog>
      ) : null}
    </>
  );
}

function StashAction({
  label,
  text,
  icon,
  tone = 'default',
  disabled,
  onClick,
}: {
  readonly label: string;
  readonly text: string;
  readonly icon: ReactNode;
  readonly tone?: 'default' | 'danger';
  readonly disabled: boolean;
  readonly onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant={tone === 'danger' ? 'subtle-danger' : 'secondary'}
      size="sm"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      {icon}
      {text}
    </Button>
  );
}
