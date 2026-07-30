/**
 * Rename one tool and pick its monogram.
 *
 * Both fields are optional overrides, so an empty field means "use the default"
 * rather than "store an empty string" — which is why the live preview always
 * shows what the avatar will actually look like after saving, defaults
 * included.
 */

import { normalizeMonogram } from '@mangostudio/shared/tool-identity';
import { type KeyboardEvent, useId, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { ToolAvatar } from '@/components/ui/ToolAvatar';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { deriveMonogram, type ResolvedToolIdentity } from './resolve';
import { useSaveToolIdentity } from './use-tool-identities';

/** Mirrors `ToolMonogramSchema`; the server is still the authority. */
const MONOGRAM_PATTERN = /^[^\s!-/:-@[-`{-~]{1,2}$/;

interface IdentityEditDialogProps {
  readonly identity: ResolvedToolIdentity;
  /** The product name, so the dialog can show what "empty" falls back to. */
  readonly defaultName: string;
  readonly onClose: () => void;
}

export function IdentityEditDialog({ identity, defaultName, onClose }: IdentityEditDialogProps) {
  const { t } = useI18n();
  const labels = t.environments.identity;
  const save = useSaveToolIdentity();
  const titleId = useId();

  // Seeded from the stored overrides, never from the resolved values: a stored
  // monogram that happens to equal the derived one still has to come back as
  // stored, or the next rename would silently discard it.
  const [name, setName] = useState(identity.storedName ?? '');
  const [monogram, setMonogram] = useState(identity.storedMonogram ?? '');

  const trimmedName = name.trim();
  const trimmedMonogram = monogram.trim();
  const monogramInvalid = trimmedMonogram.length > 0 && !MONOGRAM_PATTERN.test(trimmedMonogram);

  const previewName = trimmedName.length > 0 ? trimmedName : defaultName;
  const previewMonogram =
    trimmedMonogram.length > 0 && !monogramInvalid
      ? normalizeMonogram(trimmedMonogram)
      : deriveMonogram(previewName);

  const handleSave = () => {
    if (monogramInvalid) return;
    save.mutate(
      {
        subjectKey: identity.subjectKey,
        displayName: trimmedName.length > 0 ? trimmedName : null,
        monogram: trimmedMonogram.length > 0 ? trimmedMonogram : null,
      },
      { onSuccess: onClose }
    );
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    onClose();
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Escape is delegated from the overlay to whatever inside it holds focus.
    <div
      className="fixed inset-0 z-50 flex animate-in items-center justify-center bg-background/80 p-4 fade-in backdrop-blur-sm duration-200"
      data-testid="identity-edit-dialog"
      onKeyDown={handleKeyDown}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-sm space-y-5 rounded-3xl border border-outline-variant/20 bg-surface-container-high p-5 shadow-2xl sm:p-8"
      >
        <div className="flex items-center gap-3">
          <ToolAvatar
            subjectKey={identity.subjectKey}
            monogram={previewMonogram}
            name={previewName}
            size="lg"
          />
          <div className="min-w-0 space-y-0.5">
            <h3 id={titleId} className="truncate font-bold text-lg text-on-surface">
              {formatMessage(labels.dialogTitle, { name: identity.name })}
            </h3>
            <p className="text-on-surface-variant/60 text-xs">{labels.preview}</p>
          </div>
        </div>

        <div className="space-y-4">
          <div className="space-y-1">
            <Input
              id="tool-identity-name"
              label={labels.nameLabel}
              value={name}
              // The dialog exists to edit this field; opening it and landing
              // outside the form is the keyboard user's version of a dead end.
              autoFocus
              maxLength={64}
              placeholder={formatMessage(labels.namePlaceholder, { name: defaultName })}
              onChange={(event) => setName(event.target.value)}
            />
            <p className="text-on-surface-variant/60 text-xs">{labels.nameHint}</p>
          </div>

          <div className="space-y-1">
            <Input
              id="tool-identity-monogram"
              label={labels.monogramLabel}
              value={monogram}
              maxLength={2}
              placeholder={deriveMonogram(previewName)}
              error={monogramInvalid ? labels.monogramInvalid : undefined}
              onChange={(event) => setMonogram(event.target.value)}
            />
            {!monogramInvalid && (
              <p className="text-on-surface-variant/60 text-xs">{labels.monogramHint}</p>
            )}
          </div>
        </div>

        {save.isError && <p className="text-error text-xs">{labels.saveFailed}</p>}

        <div className="flex gap-3">
          <Button variant="secondary" onClick={onClose} className="flex-1">
            {labels.cancel}
          </Button>
          <Button
            variant="primary"
            className="flex-1"
            disabled={monogramInvalid}
            loading={save.isPending}
            onClick={handleSave}
          >
            {labels.save}
          </Button>
        </div>
      </div>
    </div>
  );
}
