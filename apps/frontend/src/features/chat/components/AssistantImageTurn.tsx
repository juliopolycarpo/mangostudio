import type { Message } from '@mangostudio/shared/chat';
import { Bookmark, Download, ImageOff, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Card } from '@/components/ui/Card';
import { Chip } from '@/components/ui/Chip';
import { EmptyState } from '@/components/ui/EmptyState';
import { useI18n } from '@/hooks/use-i18n';
import { triggerImageDownload } from '@/lib/download-image';
import { ICON_LG, ICON_MD, ICON_SM } from '@/lib/icon-sizes';
import { ImageActionBar } from './ImageActionBar';

interface AssistantImageTurnProps {
  msg: Message;
}

/**
 * Renders the right-hand column of a legacy image turn: style parameters, an
 * inline error message, or a neutral diffusion-path placeholder.
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

/**
 * Legacy single-image generation result (predating `generated_image` parts):
 * shows the produced image with download/save actions plus the meta column.
 *
 * Usage: <AssistantImageTurn msg={msg} />
 */
export function AssistantImageTurn({ msg }: AssistantImageTurnProps) {
  const { t } = useI18n();
  // Local to this row so a broken image never re-renders the whole feed.
  const [imageFailed, setImageFailed] = useState(false);
  const imageUrl = msg.imageUrl;

  return (
    <div className="flex w-full flex-col gap-4">
      {msg.generationTime && (
        <div className="flex w-fit items-center gap-2 text-xs text-fg-muted">
          <Sparkles size={ICON_SM} />
          <span>{t.chat.feed.thoughtFor.replace('{time}', msg.generationTime)}</span>
        </div>
      )}
      <div className="grid w-full grid-cols-1 items-start gap-6 md:grid-cols-2">
        {imageUrl && (
          <div className="group relative aspect-[4/5] overflow-hidden rounded-md border border-stroke bg-surface">
            {imageFailed ? (
              <EmptyState
                icon={<ImageOff size={ICON_LG} />}
                title={t.chat.feed.imageUnavailable}
                hint={t.chat.feed.imageUnavailableHint}
                className="h-full"
              />
            ) : (
              <>
                <img
                  src={imageUrl}
                  alt="Generated"
                  className="size-full object-cover"
                  decoding="async"
                  onError={() => setImageFailed(true)}
                />
                <ImageActionBar>
                  <div className="flex gap-1">
                    <Button
                      variant="subtle"
                      size="icon"
                      onClick={() =>
                        triggerImageDownload(imageUrl, t.common.downloadFilenamePrefix)
                      }
                      title={t.chat.feed.download}
                    >
                      <Download size={ICON_MD} />
                    </Button>
                    <Button variant="subtle" size="icon" title={t.chat.feed.saveToGallery}>
                      <Bookmark size={ICON_MD} />
                    </Button>
                  </div>
                  <Button variant="secondary" size="sm">
                    {t.chat.feed.regenerate}
                  </Button>
                </ImageActionBar>
              </>
            )}
          </div>
        )}
        <ImageTurnMeta msg={msg} />
      </div>
    </div>
  );
}
