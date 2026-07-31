/**
 * Creates an execution environment.
 *
 * Only the transports that actually exist are offered, and the WSL tab appears
 * only on a Windows hub that has distributions to offer — on anything else it
 * would be a tab that can never do anything. The remaining kinds land behind
 * these, so the transport row stays a picker rather than becoming one later and
 * reshuffling every field around it.
 */

import type { CreateEnvironmentBody, WslDistribution } from '@mangostudio/shared/environments';
import { useEffect, useId, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useI18n } from '@/hooks/use-i18n';
import { resolveApiErrorMessage } from '@/lib/utils';
import { useCreateEnvironmentMutation, useWslDetectionQuery } from '../queries';
import { WslDistributionPicker } from './WslDistributionPicker';

/** Mirrors `EnvironmentIdSchema`; the server is still the authority. */
const ENVIRONMENT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ENVIRONMENT_ID_MAX_LENGTH = 63;
const ENVIRONMENT_NAME_MAX_LENGTH = 80;

type TransportChoice = 'stdio' | 'wsl';

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

/** The one to offer first: the host's default, else whatever is configurable. */
function preferredDistro(distributions: readonly WslDistribution[]): string {
  const available = distributions.filter((distribution) => !distribution.environmentId);
  return (available.find((distribution) => distribution.default) ?? available[0])?.name ?? '';
}

export function AddEnvironmentDialog({ onClose }: AddEnvironmentDialogProps) {
  const { t } = useI18n();
  const labels = t.environments.entities.add;
  const create = useCreateEnvironmentMutation();
  const titleId = useId();

  const [kind, setKind] = useState<TransportChoice>('stdio');
  const [name, setName] = useState('');
  // Tracked separately so typing an id once stops the name from overwriting it.
  const [id, setId] = useState('');
  const [idEdited, setIdEdited] = useState(false);
  const [nameEdited, setNameEdited] = useState(false);
  const [binaryPath, setBinaryPath] = useState('');
  const [cwd, setCwd] = useState('');
  const [distro, setDistro] = useState('');
  const [error, setError] = useState<string | null>(null);

  const wsl = useWslDetectionQuery(true);
  const distributions = wsl.data?.distributions ?? [];
  const wslOffered = wsl.data?.available === true;

  // The host picks the distribution, not the user typing its name. Until one is
  // touched, the tab tracks whatever the host calls default.
  const selectedDistro = distro || preferredDistro(distributions);

  useEffect(() => {
    if (kind !== 'wsl' || nameEdited || !selectedDistro) return;
    setName(selectedDistro);
  }, [kind, nameEdited, selectedDistro]);

  const trimmedName = name.trim();
  const effectiveId = idEdited ? id.trim() : suggestId(trimmedName);
  const idInvalid = effectiveId.length > 0 && !ENVIRONMENT_ID_PATTERN.test(effectiveId);
  const blocked =
    trimmedName.length === 0 ||
    effectiveId.length === 0 ||
    idInvalid ||
    (kind === 'wsl' && !selectedDistro);

  const handleSubmit = async () => {
    if (blocked) return;
    setError(null);

    const trimmedBinaryPath = binaryPath.trim();
    const trimmedCwd = cwd.trim();
    const body: CreateEnvironmentBody =
      kind === 'wsl'
        ? {
            id: effectiveId,
            name: trimmedName,
            transportKind: 'wsl',
            config: { distro: selectedDistro },
          }
        : {
            id: effectiveId,
            name: trimmedName,
            transportKind: 'stdio',
            // An omitted field means "use the default"; an empty string would be
            // a path the launcher then tries to spawn.
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
            {wslOffered ? (
              <div className="grid grid-cols-2 gap-2" role="tablist">
                <TransportTab
                  active={kind === 'stdio'}
                  label={labels.stdioSummary}
                  onSelect={() => setKind('stdio')}
                />
                <TransportTab
                  active={kind === 'wsl'}
                  label={labels.wslSummary}
                  onSelect={() => setKind('wsl')}
                />
              </div>
            ) : null}
            <div className="rounded-xl border border-primary/35 bg-primary/5 px-3 py-2.5">
              {wslOffered ? null : (
                <p className="font-semibold text-on-surface text-sm">{labels.stdioSummary}</p>
              )}
              <p className={`text-on-surface-variant/70 text-xs ${wslOffered ? '' : 'mt-0.5'}`}>
                {kind === 'wsl' ? labels.wslHint : labels.stdioHint}
              </p>
            </div>
          </div>

          {kind === 'wsl' ? (
            <div className="space-y-1">
              <p className="font-medium text-on-surface-variant text-sm">{labels.wslDistroLabel}</p>
              <WslDistributionPicker
                distributions={distributions}
                selected={selectedDistro}
                onSelect={setDistro}
              />
            </div>
          ) : null}

          <Input
            id="add-environment-name"
            label={labels.nameLabel}
            value={name}
            autoFocus
            maxLength={ENVIRONMENT_NAME_MAX_LENGTH}
            // Only once something was typed: a blank untouched field is the
            // starting state, not a mistake worth flagging.
            error={name.length > 0 && trimmedName.length === 0 ? labels.nameRequired : undefined}
            onChange={(event) => {
              setNameEdited(true);
              setName(event.target.value);
            }}
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

          {kind === 'stdio' ? (
            <>
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
            </>
          ) : null}
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

function TransportTab({
  active,
  label,
  onSelect,
}: {
  readonly active: boolean;
  readonly label: string;
  readonly onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onSelect}
      className={`rounded-xl border px-3 py-2 font-semibold text-sm transition-colors ${
        active
          ? 'border-primary/45 bg-primary/10 text-on-surface'
          : 'border-outline-variant/20 text-on-surface-variant/70 hover:bg-surface-container-highest'
      }`}
    >
      {label}
    </button>
  );
}
