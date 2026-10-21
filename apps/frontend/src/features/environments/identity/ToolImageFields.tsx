/**
 * Choosing what an avatar shows.
 *
 * Three modes, because they are three different bargains and the dialog should
 * say so rather than hide them behind one "image" field: a monogram costs
 * nothing, an upload lives here, and an address is a request your browser makes
 * to somebody else's server every time the page draws this tool.
 */

import type { ChangeEvent } from 'react';
import { useId, useRef } from 'react';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Checkbox } from '@/components/ui/Checkbox';
import { Input } from '@/components/ui/Input';
import { useI18n } from '@/hooks/use-i18n';
import { cn } from '@/lib/utils';
import { choiceClass } from '../components/choice-class';

export type ToolImageMode = 'monogram' | 'upload' | 'url';

/** Mirrors the contract's `https:`-only rule; the server is still the authority. */
export const IMAGE_URL_PATTERN = /^https:\/\/\S+$/;

interface ToolImageFieldsProps {
  readonly mode: ToolImageMode;
  readonly onModeChange: (mode: ToolImageMode) => void;
  readonly file: File | null;
  readonly onFileChange: (file: File | null) => void;
  /** True when the identity already holds an upload, so no new file is needed. */
  readonly hasStoredUpload: boolean;
  /** The picked file is over the stored limit and saving is blocked on it. */
  readonly fileTooLarge: boolean;
  readonly url: string;
  readonly onUrlChange: (url: string) => void;
  readonly cache: boolean;
  readonly onCacheChange: (cache: boolean) => void;
  readonly urlInvalid: boolean;
}

export function ToolImageFields({
  mode,
  onModeChange,
  file,
  onFileChange,
  hasStoredUpload,
  fileTooLarge,
  url,
  onUrlChange,
  cache,
  onCacheChange,
  urlInvalid,
}: ToolImageFieldsProps) {
  const { t } = useI18n();
  const labels = t.environments.identity;
  const groupId = useId();
  const cacheId = useId();
  const fileInput = useRef<HTMLInputElement>(null);

  const modes: ReadonlyArray<{ value: ToolImageMode; label: string }> = [
    { value: 'monogram', label: labels.imageModeNone },
    { value: 'upload', label: labels.imageModeUpload },
    { value: 'url', label: labels.imageModeUrl },
  ];

  const handleFile = (event: ChangeEvent<HTMLInputElement>) => {
    onFileChange(event.target.files?.[0] ?? null);
  };

  return (
    <fieldset className="space-y-3">
      <legend className="text-sm font-medium text-fg">{labels.imageLabel}</legend>

      {/* Real radios rather than styled buttons: arrow-key navigation between
          the three modes comes free, and the group reads as one control. */}
      <div className="flex gap-2">
        {modes.map((option) => (
          <label
            key={option.value}
            className={cn(
              'flex flex-1 cursor-pointer items-center justify-center',
              choiceClass(mode === option.value),
              // The radio is visually hidden, so the tile carries its focus mark.
              'text-center has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-focus'
            )}
          >
            <input
              type="radio"
              name={groupId}
              value={option.value}
              checked={mode === option.value}
              className="sr-only"
              onChange={() => onModeChange(option.value)}
            />
            {option.label}
          </label>
        ))}
      </div>

      {mode === 'upload' && (
        <div className="space-y-2">
          <input
            ref={fileInput}
            type="file"
            className="hidden"
            accept="image/png,image/jpeg,image/webp"
            aria-label={labels.imageChoose}
            onChange={handleFile}
          />
          <div className="flex items-center gap-3">
            <Button variant="secondary" onClick={() => fileInput.current?.click()}>
              {hasStoredUpload || file ? labels.imageReplaceFile : labels.imageChoose}
            </Button>
            <span className="min-w-0 truncate text-xs text-fg-muted">
              {file?.name ?? (hasStoredUpload ? labels.imageStoredFile : labels.imageNoFile)}
            </span>
          </div>
          {fileTooLarge ? (
            <p className="text-xs text-danger">{labels.imageFileTooLarge}</p>
          ) : (
            <p className="text-xs text-fg-muted">{labels.imageFileHint}</p>
          )}
          {/* Owner-specified: uploading is the user asserting a right they have. */}
          <p className="text-xs text-fg-muted">{labels.imageRightsNotice}</p>
        </div>
      )}

      {mode === 'url' && (
        <div className="space-y-2">
          <Input
            id="tool-identity-image-url"
            label={labels.imageUrlLabel}
            value={url}
            inputMode="url"
            maxLength={2048}
            placeholder={labels.imageUrlPlaceholder}
            error={urlInvalid ? labels.imageUrlInvalid : undefined}
            onChange={(event) => onUrlChange(event.target.value)}
          />

          <label
            htmlFor={cacheId}
            className="flex cursor-pointer items-start gap-2 text-sm text-fg"
          >
            <Checkbox
              id={cacheId}
              checked={cache}
              className="mt-0.5"
              onChange={(event) => onCacheChange(event.target.checked)}
            />
            <span>{labels.imageCacheLabel}</span>
          </label>

          {/* The risk is the whole reason the checkbox exists, so the notice
              changes tone with it rather than sitting underneath as fine print. */}
          <Callout tone={cache ? 'neutral' : 'warning'} data-testid="tool-image-url-notice">
            {cache ? labels.imageCacheOnNotice : labels.imageCacheOffNotice}
          </Callout>
        </div>
      )}
    </fieldset>
  );
}
