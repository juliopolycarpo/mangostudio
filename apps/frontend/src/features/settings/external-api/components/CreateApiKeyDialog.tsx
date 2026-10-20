import {
  API_KEY_EXPIRY_MAX_DAYS,
  API_KEY_NAME_MAX_LENGTH,
  API_KEY_SCOPES,
  type ApiKeyScope,
  type CreateApiKeyResponse,
} from '@mangostudio/shared/api-keys';
import { Check, Copy, KeyRound, X } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { useClipboard } from '@/hooks/use-clipboard';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { resolveApiErrorMessage } from '@/lib/utils';
import { scopeHint, scopeLabel } from '../format';
import { useCreateApiKey } from '../hooks/use-api-key-mutations';

interface CreateApiKeyDialogProps {
  readonly onClose: () => void;
}

const FIELD_CLASS =
  'w-full rounded-xl border border-stroke bg-control px-4 py-2.5 text-sm text-fg outline-none transition-colors focus:border-focus focus:ring-1 focus:ring-focus';

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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-scrim animate-in fade-in duration-200">
      <div className="bg-surface w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-3xl p-5 sm:p-8 shadow-2xl border border-stroke space-y-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <h3 className="text-xl font-bold text-fg">{created ? reveal.title : labels.title}</h3>
            {!created && <p className="text-sm text-fg-muted">{scopeHint(t, scope)}</p>}
          </div>
          <Button
            variant="subtle"
            size="sm"
            aria-label={labels.cancelButton}
            disabled={createMutation.isPending}
            onClick={onClose}
          >
            <X size={16} />
          </Button>
        </div>

        {created ? (
          <div className="space-y-4">
            <div className="flex items-start gap-3 rounded-2xl border border-warning bg-warning-subtle p-4">
              <KeyRound size={18} className="mt-0.5 shrink-0 text-warning" />
              <p className="text-sm text-fg">{reveal.notice}</p>
            </div>
            <code
              className="block break-all rounded-2xl bg-control px-4 py-3 font-mono text-xs text-fg border border-stroke"
              data-testid="api-key-plaintext"
            >
              {created.key}
            </code>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" onClick={() => void copy(created.key)}>
                {copied ? <Check size={14} /> : <Copy size={14} />}
                {copied ? reveal.copied : reveal.copy}
              </Button>
            </div>
            {copyFailed && <p className="text-xs text-danger">{reveal.copyFailed}</p>}
            <div className="flex justify-end pt-2">
              <Button onClick={onClose}>{reveal.done}</Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <label className="block space-y-2">
              <span className="block text-sm font-semibold text-fg">{labels.nameLabel}</span>
              <input
                type="text"
                value={name}
                maxLength={API_KEY_NAME_MAX_LENGTH}
                onChange={(event) => {
                  setName(event.target.value);
                  if (nameError) setNameError(null);
                }}
                placeholder={labels.namePlaceholder}
                aria-label={labels.nameLabel}
                aria-invalid={Boolean(nameError)}
                className={FIELD_CLASS}
              />
              {nameError && <span className="block text-xs text-danger">{nameError}</span>}
            </label>

            <div className="space-y-2">
              <span className="block text-sm font-semibold text-fg">{labels.scopeLabel}</span>
              <Select
                value={scope}
                onChange={(value) => setScope(value as ApiKeyScope)}
                ariaLabel={labels.scopeLabel}
                options={API_KEY_SCOPES.map((value) => ({
                  value,
                  label: scopeLabel(t, value),
                }))}
              />
            </div>

            <label className="block space-y-2">
              <span className="block text-sm font-semibold text-fg">{labels.expiresLabel}</span>
              <span className="block text-xs text-fg-muted">
                {formatMessage(labels.expiresHint, { max: String(API_KEY_EXPIRY_MAX_DAYS) })}
              </span>
              <input
                type="number"
                min={1}
                max={API_KEY_EXPIRY_MAX_DAYS}
                step={1}
                value={expiresInDays}
                onChange={(event) => {
                  setExpiresInDays(event.target.value);
                  if (expiresError) setExpiresError(null);
                }}
                aria-label={labels.expiresLabel}
                aria-invalid={Boolean(expiresError)}
                className={FIELD_CLASS}
              />
              {expiresError && <span className="block text-xs text-danger">{expiresError}</span>}
            </label>

            {submitError && <p className="text-sm text-danger">{submitError}</p>}

            <div className="flex gap-3 pt-2">
              <Button
                variant="secondary"
                className="flex-1"
                disabled={createMutation.isPending}
                onClick={onClose}
              >
                {labels.cancelButton}
              </Button>
              <Button className="flex-1" loading={createMutation.isPending} onClick={handleSubmit}>
                {createMutation.isPending ? labels.creatingButton : labels.createButton}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
