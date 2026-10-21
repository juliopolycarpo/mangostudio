import type { Message } from '@mangostudio/shared/chat';
import { Download, ImageOff, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Card } from '@/components/ui/Card';
import { Chip } from '@/components/ui/Chip';
import { EmptyState } from '@/components/ui/EmptyState';
import { useI18n } from '@/hooks/use-i18n';
import { triggerImageDownload } from '@/lib/download-image';
import { ICON_LG, ICON_MD } from '@/lib/icon-sizes';
import { cn } from '@/lib/utils';
import { ImageActionBar } from './ImageActionBar';
import { ReservedAspectImage } from './ReservedAspectImage';

interface AssistantImageTurnProps {
  msg: Message;
}

/**
 * What a legacy image turn says beside its picture: style parameters, or — when
 * there is no picture — an inline error message or a neutral diffusion-path
 * placeholder.
 *
 * Whether there is anything to say is decided once, by {@link hasImageTurnMeta},
 * so the grid around it can drop its second column instead of leaving it empty.
 */
function ImageTurnMeta({ msg }: AssistantImageTurnProps) {
  const { t } = useI18n();
  return (
    <div className="space-y-6">
      {msg.styleParams && msg.styleParams.length > 0 && (
        <Card>
          <h3 className="mb-4 flex items-center gap-2 text-sm font-semibold text-fg">
            <Sparkles className="text-fg-muted" size={ICON_MD} />
            {t.chat.feed.styleParams}
          </h3>
          <div className="flex flex-wrap gap-2">
            {msg.styleParams.map((param) => (
              <Chip key={param}>{param}</Chip>
            ))}
          </div>
        </Card>
      )}
      {msg.text && !msg.imageUrl && <Callout tone="danger">{msg.text}</Callout>}
      {!msg.text && !msg.imageUrl && (
        <Callout tone="neutral">{t.chat.feed.neuralDiffusionPath}</Callout>
      )}
    </div>
  );
}

/** Whether {@link ImageTurnMeta} has a single thing to draw for this turn. */
function hasImageTurnMeta(msg: Message): boolean {
  return (msg.styleParams?.length ?? 0) > 0 || !msg.imageUrl;
}

/**
 * Legacy single-image generation result (predating `generated_image` parts):
 * shows the produced image with its download action, plus the meta column when
 * there is one. How long it took is the turn's closing line, drawn under it by
 * `AssistantMessageBlock` like every other turn's.
 *
 * Usage: <AssistantImageTurn msg={msg} />
 */
export function AssistantImageTurn({ msg }: AssistantImageTurnProps) {
  const { t } = useI18n();
  // Local to this row so a broken image never re-renders the whole feed.
  const [imageFailed, setImageFailed] = useState(false);
  const imageUrl = msg.imageUrl;
  // A picture with no style parameters has nothing to sit beside, and a second
  // column of nothing left the picture hugging the left half of the row.
  const showsMeta = hasImageTurnMeta(msg);

  return (
    // One indent in from the rail, like every other block of a turn.
    <div
      className={cn(
        'grid w-full grid-cols-1 items-start gap-6 pl-4',
        imageUrl && showsMeta && 'md:grid-cols-2'
      )}
    >
      {imageUrl && (
        // The same card a generated image part draws: a reserved frame the
        // picture is fitted into, not a 4:5 crop that cut off its edges. The
        // frame is the card's own surface, so a picture that is not square
        // letterboxes into the card rather than into a darker well inside it.
        <div className="group relative max-w-md overflow-hidden rounded-md border border-stroke bg-surface">
          {imageFailed ? (
            <EmptyState
              icon={<ImageOff size={ICON_LG} />}
              title={t.chat.feed.imageUnavailable}
              hint={t.chat.feed.imageUnavailableHint}
              className="aspect-square"
            />
          ) : (
            <>
              <ReservedAspectImage
                src={imageUrl}
                alt={t.chat.feed.generatedImageAlt}
                objectFit="contain"
                onLoadError={() => setImageFailed(true)}
              />
              <ImageActionBar className="justify-end">
                <Button
                  variant="subtle"
                  size="icon"
                  onClick={() => triggerImageDownload(imageUrl, t.common.downloadFilenamePrefix)}
                  title={t.chat.feed.download}
                >
                  <Download size={ICON_MD} />
                </Button>
              </ImageActionBar>
            </>
          )}
        </div>
      )}
      {showsMeta && <ImageTurnMeta msg={msg} />}
    </div>
  );
}
