/**
 * Creates an execution environment.
 *
 * Only the transports that actually exist are offered, so today this is a
 * single kind rather than a picker over a list of stubs. The transport row is
 * still rendered as a choice because the remaining kinds land behind it, and a
 * form that grows a selector later would reshuffle every field around it.
 */

import type { CreateEnvironmentBody } from '@mangostudio/shared/environments';
import { useId, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useI18n } from '@/hooks/use-i18n';
import { resolveApiErrorMessage } from '@/lib/utils';
import { useCreateEnvironmentMutation } from '../queries';

/** Mirrors `EnvironmentIdSchema`; the server is still the authority. */
const ENVIRONMENT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ENVIRONMENT_ID_MAX_LENGTH = 63;
const ENVIRONMENT_NAME_MAX_LENGTH = 80;

interface AddEnvironmentDialogProps {
  readonly onClose: () => void;
}

/** Derives an id from a name so the common case needs one field, not two. */
function suggestId(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, ENVIRONMENT_ID_MAX_LENGTH)
      // The cut can land just after an internal dash, and a trailing one fails
      // the pattern — leaving submit disabled over an id the user never typed.
      .replace(/-+$/, '')
  );
}

export function AddEnvironmentDialog({ onClose }: AddEnvironmentDialogProps) {
  const { t } = useI18n();
  const labels = t.environments.entities.add;
  const create = useCreateEnvironmentMutation();
  const titleId = useId();

  const [name, setName] = useState('');
  // Tracked separately so typing an id once stops the name from overwriting it.
  const [id, setId] = useState('');
  const [idEdited, setIdEdited] = useState(false);
  const [binaryPath, setBinaryPath] = useState('');
  const [cwd, setCwd] = useState('');
  const [error, setError] = useState<string | null>(null);

  const trimmedName = name.trim();
  const effectiveId = idEdited ? id.trim() : suggestId(trimmedName);
  const idInvalid = effectiveId.length > 0 && !ENVIRONMENT_ID_PATTERN.test(effectiveId);
  const blocked = trimmedName.length === 0 || effectiveId.length === 0 || idInvalid;

  const handleSubmit = async () => {
    if (blocked) return;
    setError(null);

    const trimmedBinaryPath = binaryPath.trim();
    const trimmedCwd = cwd.trim();
    const body: CreateEnvironmentBody = {
      id: effectiveId,
      name: trimmedName,
      transportKind: 'stdio',
      // An omitted field means "use the default"; an empty string would be a
      // path the launcher then tries to spawn.
      config: {
        ...(trimmedBinaryPath ? { binaryPath: trimmedBinaryPath } : {}),
        ...(trimmedCwd ? { cwd: trimmedCwd } : {}),
      },
    };

    try {
      await create.mutateAsync(body);
      onClose();
    } catch (caught) {
      setError(resolveApiErrorMessage(caught, labels.createFailed));
    }
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Escape is delegated from the overlay to whatever inside it holds focus.
    <div
      className="fixed inset-0 z-50 flex animate-in items-center justify-center bg-background/80 p-4 fade-in backdrop-blur-sm duration-200"
      data-testid="add-environment-dialog"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="max-h-full w-full max-w-md space-y-5 overflow-y-auto rounded-3xl border border-outline-variant/20 bg-surface-container-high p-5 shadow-2xl sm:p-8"
      >
        <div className="space-y-1">
          <h3 id={titleId} className="font-bold text-lg text-on-surface">
            {labels.title}
          </h3>
          <p className="text-on-surface-variant/60 text-xs">{labels.description}</p>
        </div>

        <div className="space-y-4">
          <div className="space-y-1">
            <p className="font-medium text-on-surface-variant text-sm">{labels.kindLabel}</p>
            <div className="rounded-xl border border-primary/35 bg-primary/5 px-3 py-2.5">
              <p className="font-semibold text-on-surface text-sm">{labels.stdioSummary}</p>
              <p className="mt-0.5 text-on-surface-variant/70 text-xs">{labels.stdioHint}</p>
            </div>
          </div>

          <Input
            id="add-environment-name"
            label={labels.nameLabel}
            value={name}
            autoFocus
            maxLength={ENVIRONMENT_NAME_MAX_LENGTH}
            // Only once something was typed: a blank untouched field is the
            // starting state, not a mistake worth flagging.
            error={name.length > 0 && trimmedName.length === 0 ? labels.nameRequired : undefined}
            onChange={(event) => setName(event.target.value)}
          />

          <div className="space-y-1">
            <Input
              id="add-environment-id"
              label={labels.idLabel}
              value={effectiveId}
              maxLength={ENVIRONMENT_ID_MAX_LENGTH}
              error={idInvalid ? labels.idInvalid : undefined}
              onChange={(event) => {
                setIdEdited(true);
                setId(event.target.value);
              }}
            />
            {!idInvalid && <p className="text-on-surface-variant/60 text-xs">{labels.idHint}</p>}
          </div>

          <div className="space-y-1">
            <Input
              id="add-environment-binary-path"
              label={`${labels.binaryPathLabel} · ${labels.optional}`}
              value={binaryPath}
              onChange={(event) => setBinaryPath(event.target.value)}
            />
            <p className="text-on-surface-variant/60 text-xs">{labels.binaryPathHint}</p>
          </div>

          <div className="space-y-1">
            <Input
              id="add-environment-cwd"
              label={`${labels.cwdLabel} · ${labels.optional}`}
              value={cwd}
              onChange={(event) => setCwd(event.target.value)}
            />
            <p className="text-on-surface-variant/60 text-xs">{labels.cwdHint}</p>
          </div>
        </div>

        {error ? (
          <p className="text-error text-xs" role="alert">
            {error}
          </p>
        ) : null}

        <div className="flex gap-3">
          <Button variant="secondary" onClick={onClose} className="flex-1">
            {labels.cancel}
          </Button>
          <Button
            variant="primary"
            className="flex-1"
            disabled={blocked}
            loading={create.isPending}
            onClick={() => void handleSubmit()}
          >
            {labels.submit}
          </Button>
        </div>
      </div>
    </div>
  );
}
