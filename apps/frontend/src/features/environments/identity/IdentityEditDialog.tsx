/**
 * Rename one tool, pick its monogram, and choose what its avatar shows.
 *
 * Every field is an optional override, so an empty one means "use the default"
 * rather than "store an empty string" — which is why the live preview always
 * shows what the avatar will actually look like after saving, defaults and
 * images included.
 */

import { normalizeMonogram } from '@mangostudio/shared/tool-identity';
import { type KeyboardEvent, useEffect, useId, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { ToolAvatar, type ToolImageDisplay } from '@/components/ui/ToolAvatar';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { deriveMonogram, type ResolvedToolIdentity } from './resolve';
import { IMAGE_URL_PATTERN, ToolImageFields, type ToolImageMode } from './ToolImageFields';
import { useSaveToolIdentity } from './use-tool-identities';

/** Mirrors `ToolMonogramSchema`; the server is still the authority. */
const MONOGRAM_PATTERN = /^[^\s!-/:-@[-`{-~]{1,2}$/;

interface IdentityEditDialogProps {
  readonly identity: ResolvedToolIdentity;
  /** The product name, so the dialog can show what "empty" falls back to. */
  readonly defaultName: string;
  readonly onClose: () => void;
}

function initialMode(identity: ResolvedToolIdentity): ToolImageMode {
  return identity.storedImage?.source ?? 'monogram';
}

/**
 * A previewable address for a file that has not been uploaded yet, revoked when
 * the file is replaced or the dialog closes so the blob is not held for the
 * life of the page.
 */
function useFilePreviewUrl(file: File | null): string | null {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    // Absent under jsdom, where there is nothing to preview anyway.
    if (!file || typeof URL.createObjectURL !== 'function') {
      setUrl(null);
      return;
    }

    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);

  return url;
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
  const [imageMode, setImageMode] = useState<ToolImageMode>(() => initialMode(identity));
  const [file, setFile] = useState<File | null>(null);
  const [imageUrl, setImageUrl] = useState(identity.storedImage?.url ?? '');
  // Caching is the option that keeps the remote host out of the picture, so it
  // is what a new URL starts on.
  const [cacheImage, setCacheImage] = useState(identity.storedImage?.cached ?? true);

  const trimmedName = name.trim();
  const trimmedMonogram = monogram.trim();
  const trimmedUrl = imageUrl.trim();
  const monogramInvalid = trimmedMonogram.length > 0 && !MONOGRAM_PATTERN.test(trimmedMonogram);
  const urlInvalid = imageMode === 'url' && !IMAGE_URL_PATTERN.test(trimmedUrl);

  const hasStoredUpload = identity.storedImage?.source === 'upload';
  // Switching to upload without picking anything would ask the server to store
  // an image that does not exist.
  const fileMissing = imageMode === 'upload' && !file && !hasStoredUpload;

  const previewName = trimmedName.length > 0 ? trimmedName : defaultName;
  const previewMonogram =
    trimmedMonogram.length > 0 && !monogramInvalid
      ? normalizeMonogram(trimmedMonogram)
      : deriveMonogram(previewName);
  const filePreviewUrl = useFilePreviewUrl(file);
  const previewImage = resolvePreviewImage(
    identity,
    imageMode,
    filePreviewUrl,
    trimmedUrl,
    urlInvalid
  );

  const blocked = monogramInvalid || urlInvalid || fileMissing;

  const handleSave = () => {
    if (blocked) return;
    save.mutate(
      {
        subjectKey: identity.subjectKey,
        displayName: trimmedName.length > 0 ? trimmedName : null,
        monogram: trimmedMonogram.length > 0 ? trimmedMonogram : null,
        // `undefined` leaves the stored image alone, which is what an upload
        // needs: the file that replaces it arrives in the next request.
        image:
          imageMode === 'monogram'
            ? null
            : imageMode === 'url'
              ? { source: 'url' as const, url: trimmedUrl, cache: cacheImage }
              : undefined,
        imageFile: imageMode === 'upload' ? file : null,
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
        className="max-h-full w-full max-w-md space-y-5 overflow-y-auto rounded-3xl border border-outline-variant/20 bg-surface-container-high p-5 shadow-2xl sm:p-8"
      >
        <div className="flex items-center gap-3">
          <ToolAvatar
            subjectKey={identity.subjectKey}
            monogram={previewMonogram}
            name={previewName}
            image={previewImage}
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

          <ToolImageFields
            mode={imageMode}
            onModeChange={setImageMode}
            file={file}
            onFileChange={setFile}
            hasStoredUpload={hasStoredUpload}
            url={imageUrl}
            onUrlChange={setImageUrl}
            cache={cacheImage}
            onCacheChange={setCacheImage}
            urlInvalid={urlInvalid && trimmedUrl.length > 0}
          />
        </div>

        {save.isError && <p className="text-error text-xs">{labels.saveFailed}</p>}

        <div className="flex gap-3">
          <Button variant="secondary" onClick={onClose} className="flex-1">
            {labels.cancel}
          </Button>
          <Button
            variant="primary"
            className="flex-1"
            disabled={blocked}
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

/**
 * What the preview avatar should draw right now. A picked file is previewed
 * from its object URL — the only way to show the real image before it has been
 * uploaded — and anything unusable falls back to the monogram, exactly as the
 * saved avatar would.
 */
function resolvePreviewImage(
  identity: ResolvedToolIdentity,
  mode: ToolImageMode,
  filePreviewUrl: string | null,
  url: string,
  urlInvalid: boolean
): ToolImageDisplay | null {
  if (mode === 'monogram') return null;
  if (mode === 'url') return urlInvalid ? null : { src: url, remote: true };
  if (filePreviewUrl) return { src: filePreviewUrl, remote: false };
  return identity.storedImage?.source === 'upload' ? identity.image : null;
}
