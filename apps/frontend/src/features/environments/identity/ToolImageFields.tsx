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
import { Input } from '@/components/ui/Input';
import { useI18n } from '@/hooks/use-i18n';

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
      <legend className="font-medium text-on-surface-variant text-sm">{labels.imageLabel}</legend>

      {/* Real radios rather than styled buttons: arrow-key navigation between
          the three modes comes free, and the group reads as one control. */}
      <div className="flex gap-2">
        {modes.map((option) => (
          <label
            key={option.value}
            className={`flex-1 cursor-pointer rounded-xl border px-3 py-2 text-center text-xs transition-colors focus-within:ring-1 focus-within:ring-primary/40 ${
              mode === option.value
                ? 'border-primary/60 bg-primary/10 text-on-surface'
                : 'border-outline-variant/20 text-on-surface-variant hover:bg-surface-container-highest'
            }`}
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
            <span className="min-w-0 truncate text-on-surface-variant/60 text-xs">
              {file?.name ?? (hasStoredUpload ? labels.imageStoredFile : labels.imageNoFile)}
            </span>
          </div>
          <p className="text-on-surface-variant/60 text-xs">{labels.imageFileHint}</p>
          {/* Owner-specified: uploading is the user asserting a right they have. */}
          <p className="text-on-surface-variant/60 text-xs">{labels.imageRightsNotice}</p>
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
            className="flex cursor-pointer items-start gap-2 text-on-surface text-xs"
          >
            <input
              id={cacheId}
              type="checkbox"
              checked={cache}
              className="mt-0.5 cursor-pointer accent-primary"
              onChange={(event) => onCacheChange(event.target.checked)}
            />
            <span>{labels.imageCacheLabel}</span>
          </label>

          {/* The risk is the whole reason the checkbox exists, so the copy
              changes with it rather than sitting underneath as fine print. */}
          <p
            data-testid="tool-image-url-notice"
            className={`text-xs ${cache ? 'text-on-surface-variant/60' : 'text-warning'}`}
          >
            {cache ? labels.imageCacheOnNotice : labels.imageCacheOffNotice}
          </p>
        </div>
      )}
    </fieldset>
  );
}
