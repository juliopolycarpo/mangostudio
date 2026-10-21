import {
  API_KEY_EXPIRY_MAX_DAYS,
  API_KEY_NAME_MAX_LENGTH,
  API_KEY_SCOPES,
  type ApiKeyScope,
  type CreateApiKeyResponse,
} from '@mangostudio/shared/api-keys';
import { Check, Copy, KeyRound } from 'lucide-react';
import { useState } from 'react';
import { SettingsField } from '@/components/settings/SettingsField';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Dialog } from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { useClipboard } from '@/hooks/use-clipboard';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { ICON_MD, ICON_SM } from '@/lib/icon-sizes';
import { resolveApiErrorMessage } from '@/lib/utils';
import { scopeHint, scopeLabel } from '../format';
import { useCreateApiKey } from '../hooks/use-api-key-mutations';

interface CreateApiKeyDialogProps {
  readonly onClose: () => void;
}

export function CreateApiKeyDialog({ onClose }: CreateApiKeyDialogProps) {
  const { t } = useI18n();
  const s = t.settings.externalApi;
  const labels = s.createDialog;
  const reveal = s.reveal;
  const createMutation = useCreateApiKey();
  const { copy, copied, failed: copyFailed } = useClipboard();

  const [name, setName] = useState('');
  const [scope, setScope] = useState<ApiKeyScope>('read-only');
  const [expiresInDays, setExpiresInDays] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [expiresError, setExpiresError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Plaintext lives only in this dialog's state — never written to the query
  // cache, and `useCreateApiKey` pins `gcTime: 0` so the mutation result is not
  // parked in the MutationCache after the dialog unmounts either.
  const [created, setCreated] = useState<CreateApiKeyResponse | null>(null);

  const handleSubmit = () => {
    // Clear the previous attempt's server error first: a validation bounce
    // otherwise leaves a stale "failed to create" line under a form that was
    // never resubmitted.
    setSubmitError(null);

    const trimmedName = name.trim();
    if (!trimmedName) {
      setNameError(labels.nameRequired);
      return;
    }
    setNameError(null);

    let parsedExpires: number | undefined;
    const expiresDraft = expiresInDays.trim();
    if (expiresDraft) {
      const parsed = Number.parseInt(expiresDraft, 10);
      if (
        Number.isNaN(parsed) ||
        String(parsed) !== expiresDraft ||
        parsed < 1 ||
        parsed > API_KEY_EXPIRY_MAX_DAYS
      ) {
        setExpiresError(
          formatMessage(labels.expiresInvalid, { max: String(API_KEY_EXPIRY_MAX_DAYS) })
        );
        return;
      }
      parsedExpires = parsed;
    }
    setExpiresError(null);

    createMutation.mutate(
      {
        name: trimmedName,
        scope,
        ...(parsedExpires !== undefined && { expiresInDays: parsedExpires }),
      },
      {
        onSuccess: (response) => setCreated(response),
        onError: (error) => setSubmitError(resolveApiErrorMessage(error, s.failedToCreate)),
      }
    );
  };

  const pending = createMutation.isPending;

  if (created) {
    return (
      <Dialog
        title={reveal.title}
        onClose={onClose}
        footer={<Button onClick={onClose}>{reveal.done}</Button>}
      >
        <Callout tone="warning" icon={<KeyRound size={ICON_MD} />}>
          {reveal.notice}
        </Callout>
        <code
          className="block break-all rounded-md border border-stroke bg-canvas px-3 py-2 font-mono text-xs text-fg"
          data-testid="api-key-plaintext"
        >
          {created.key}
        </code>
        <div>
          <Button variant="secondary" size="sm" onClick={() => void copy(created.key)}>
            {copied ? <Check size={ICON_SM} /> : <Copy size={ICON_SM} />}
            {copied ? reveal.copied : reveal.copy}
          </Button>
        </div>
        {copyFailed && <Callout tone="danger">{reveal.copyFailed}</Callout>}
      </Dialog>
    );
  }

  return (
    <Dialog
      title={labels.title}
      description={labels.description}
      onClose={onClose}
      closeDisabled={pending}
      notice={submitError ? <Callout tone="danger">{submitError}</Callout> : undefined}
      footer={
        <>
          <Button variant="secondary" disabled={pending} onClick={onClose}>
            {labels.cancelButton}
          </Button>
          <Button loading={pending} onClick={handleSubmit}>
            {pending ? labels.creatingButton : labels.createButton}
          </Button>
        </>
      }
    >
      <Input
        id="api-key-name"
        label={labels.nameLabel}
        type="text"
        value={name}
        maxLength={API_KEY_NAME_MAX_LENGTH}
        onChange={(event) => {
          setName(event.target.value);
          if (nameError) setNameError(null);
        }}
        placeholder={labels.namePlaceholder}
        error={nameError ?? undefined}
      />

      {/* The hint belongs to the field it describes and follows the choice. */}
      <SettingsField label={labels.scopeLabel} htmlFor="api-key-scope" hint={scopeHint(t, scope)}>
        <Select
          id="api-key-scope"
          value={scope}
          onChange={(value) => setScope(value as ApiKeyScope)}
          ariaLabel={labels.scopeLabel}
          options={API_KEY_SCOPES.map((value) => ({
            value,
            label: scopeLabel(t, value),
          }))}
        />
      </SettingsField>

      <div className="space-y-1">
        <Input
          id="api-key-expires"
          label={labels.expiresLabel}
          type="number"
          min={1}
          max={API_KEY_EXPIRY_MAX_DAYS}
          step={1}
          value={expiresInDays}
          onChange={(event) => {
            setExpiresInDays(event.target.value);
            if (expiresError) setExpiresError(null);
          }}
          error={expiresError ?? undefined}
        />
        <p className="text-xs text-fg-muted">
          {formatMessage(labels.expiresHint, { max: String(API_KEY_EXPIRY_MAX_DAYS) })}
        </p>
      </div>
    </Dialog>
  );
}
