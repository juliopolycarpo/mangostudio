import type { ApiKeySummary } from '@mangostudio/shared/api-keys';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useI18n } from '@/hooks/use-i18n';
import { displayKeyName } from '../format';

interface RevokeApiKeyDialogProps {
  readonly apiKey: ApiKeySummary;
  readonly isPending: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

export function RevokeApiKeyDialog({
  apiKey,
  isPending,
  onConfirm,
  onCancel,
}: RevokeApiKeyDialogProps) {
  const { t } = useI18n();
  const s = t.settings.externalApi.revoke;

  return (
    <ConfirmDialog
      title={s.title}
      description={s.confirm}
      entityName={displayKeyName(t, apiKey.name)}
      confirmLabel={s.confirmButton}
      cancelLabel={s.cancelButton}
      isPending={isPending}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}
