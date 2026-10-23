import type { GeneratedImagePart as GeneratedImagePartType } from '@mangostudio/shared/types';
import { Download, Image, ImageOff, Timer } from 'lucide-react';
import { AnimatePresence } from 'motion/react';
import * as motion from 'motion/react-m';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Chip } from '@/components/ui/Chip';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { useI18n } from '@/hooks/use-i18n';
import { triggerImageDownload } from '@/lib/download-image';
import { formatMessage } from '@/lib/i18n-format';
import { ICON_LG, ICON_MD, ICON_SM } from '@/lib/icon-sizes';
import { useMotionPresets } from '@/lib/motion/use-motion-presets';
import { DisclosureChevron } from './DisclosureChevron';
import { ImageActionBar } from './ImageActionBar';
import { ReservedAspectImage } from './ReservedAspectImage';

interface Props {
  part: GeneratedImagePartType;
}

export function GeneratedImagePart({ part }: Props) {
  const { t } = useI18n();
  const [loadError, setLoadError] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const { collapse } = useMotionPresets();

  const promptSnippet =
    part.prompt && part.prompt.length > 80 ? `${part.prompt.slice(0, 80)}…` : part.prompt;

  // How long the picture took to make — not thinking, and not the turn's own
  // time, which the turn's closing line states under it.
  const generationTimeLabel = part.generationTime
    ? formatMessage(t.chat.feed.generatedIn, { time: part.generationTime })
    : null;

  const modelLabel = part.modelName ?? null;

  // The picture's card stays at 28rem rather than the timeline's card measure:
  // its frame is a reserved square (the part carries no dimensions, and the
  // only provider renders 1:1), so at 41rem a square would be 656px tall. The
  // cards that hold text end where the prose bubble does; this one holds a
  // picture and is sized by it. The frame is the card's own surface rather than
  // a canvas well: a picture that is not square letterboxes into the card, not
  // into a darker hole that read as still loading.
  if (part.status === 'completed' && part.imageUrl && !loadError) {
    const imageUrl = part.imageUrl;

    return (
      <div className="max-w-md overflow-hidden rounded-md border border-stroke bg-surface">
        <button
          type="button"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((v) => !v)}
          className="flex h-8 w-full cursor-pointer items-center gap-2 px-3 transition-colors hover:bg-fill-hover"
        >
          <Image size={ICON_SM} className="shrink-0 text-fg-muted" />
          <span className="flex-1 truncate text-left text-xs text-fg-muted">
            {promptSnippet || t.chat.feed.generatedImageAlt}
          </span>
          <DisclosureChevron expanded={!collapsed} />
        </button>

        <AnimatePresence initial={false}>
          {!collapsed && (
            <motion.div key="image-content" {...collapse}>
              {/* Meta bar: model + generation time */}
              {(modelLabel || generationTimeLabel) && (
                <div className="flex flex-wrap items-center gap-2 px-3 pb-2">
                  {modelLabel && <Chip>{modelLabel}</Chip>}
                  {generationTimeLabel && (
                    <span className="flex items-center gap-1.5 font-mono text-micro text-fg-subtle">
                      <Timer size={ICON_SM} aria-hidden="true" className="shrink-0" />
                      {generationTimeLabel}
                    </span>
                  )}
                </div>
              )}

              <div className="group relative">
                <ReservedAspectImage
                  src={imageUrl}
                  alt={t.chat.feed.generatedImageAlt}
                  objectFit="contain"
                  onLoadError={() => setLoadError(true)}
                />
                <ImageActionBar className="justify-end">
                  <Button
                    variant="subtle"
                    size="icon"
                    onClick={(e) => {
                      e.stopPropagation();
                      triggerImageDownload(imageUrl, t.common.downloadFilenamePrefix);
                    }}
                    title={t.chat.feed.download}
                  >
                    <Download size={ICON_MD} />
                  </Button>
                </ImageActionBar>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    );
  }

  if (part.status === 'completed' && loadError) {
    return (
      <EmptyState
        icon={<ImageOff size={ICON_LG} />}
        title={t.chat.feed.imageUnavailable}
        action={modelLabel ? <Chip>{modelLabel}</Chip> : undefined}
        className="max-w-(--timeline-card-max) rounded-md border border-stroke bg-surface"
      />
    );
  }

  if (part.status === 'error') {
    // `errorCode` names a closed, renderable reason; `error` alone is the
    // model-facing text and stays in English, so only the coded case can be
    // localized here.
    const errorDetail =
      part.errorCode === 'image_generation_interrupted'
        ? t.errors.imageGenerationInterrupted
        : part.error;
    const meta = [modelLabel, generationTimeLabel].filter(Boolean).join(' · ');
    return (
      <Callout
        tone="danger"
        title={t.chat.feed.imageGenerationFailed}
        className="max-w-(--timeline-card-max)"
      >
        {errorDetail || meta ? (
          <div className="space-y-1">
            {errorDetail && <p className="leading-relaxed">{errorDetail}</p>}
            {meta && <p className="font-mono text-micro text-fg-subtle">{meta}</p>}
          </div>
        ) : null}
      </Callout>
    );
  }

  return (
    <div className="flex max-w-md flex-col gap-3 rounded-md border border-stroke bg-surface p-4">
      <div className="flex items-center gap-2">
        <Image size={ICON_MD} className="shrink-0 text-fg-muted" />
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-xs font-medium text-fg">
            {modelLabel
              ? t.chat.feed.modelStatus
                  .replace('{status}', t.chat.feed.statusGenerating)
                  .replace('{model}', () => modelLabel)
              : t.chat.feed.generatingImage}
          </span>
          <span className="text-xs text-fg-subtle">{part.prompt}</span>
        </div>
      </div>
      {/* Reserve square aspect space so the skeleton is close in height to
          the completed image. Prevents a large row-size jump in the virtual
          feed when the status flips to completed. */}
      <Skeleton className="aspect-square w-full" />
      <div className="h-1 w-full overflow-hidden rounded-full bg-fill-selected">
        <div className="h-full w-1/3 animate-slide rounded-full bg-accent" />
      </div>
    </div>
  );
}
