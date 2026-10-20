import type { Message } from '@mangostudio/shared/chat';
import { Bookmark, Download, ImageOff, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '@/hooks/use-i18n';
import { triggerImageDownload } from '@/lib/download-image';

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
        <div className="bg-surface p-6 rounded-xl border border-stroke">
          <h3 className="text-sm font-bold mb-4 flex items-center gap-2 text-fg">
            <Sparkles className="text-accent-fg" size={16} />
            {t.chat.feed.styleParams}
          </h3>
          <div className="flex flex-wrap gap-2">
            {msg.styleParams.map((param) => (
              <span
                key={param}
                className="px-3 py-1 bg-surface text-fg-muted text-[10px] font-bold rounded-sm uppercase tracking-wider"
              >
                {param}
              </span>
            ))}
          </div>
        </div>
      )}
      {msg.text && !msg.imageUrl && (
        <div className="bg-danger-subtle border border-danger p-4 rounded-xl text-danger text-sm">
          {msg.text}
        </div>
      )}
      {!msg.text && !msg.imageUrl && (
        <div className="bg-control p-6 rounded-xl border border-stroke">
          <p className="text-xs text-fg-muted leading-relaxed">{t.chat.feed.neuralDiffusionPath}</p>
        </div>
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
    <div className="flex flex-col gap-4 w-full">
      {msg.generationTime && (
        <div className="flex items-center gap-2 text-xs text-fg-muted bg-control py-2 px-3 rounded-lg w-fit border border-stroke">
          <Sparkles size={12} className="text-accent-fg" />
          <span>{t.chat.feed.thoughtFor.replace('{time}', msg.generationTime)}</span>
        </div>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-start w-full">
        {imageUrl && (
          <div className="group relative bg-control rounded-xl overflow-hidden aspect-[4/5] shadow-2xl transition-transform duration-500">
            {imageFailed ? (
              <div className="w-full h-full flex flex-col items-center justify-center text-fg-subtle p-6 text-center bg-surface">
                <ImageOff size={48} className="mb-4 opacity-50" />
                <p className="font-bold mb-2">{t.chat.feed.imageUnavailable}</p>
                <p className="text-xs">{t.chat.feed.imageUnavailableHint}</p>
              </div>
            ) : (
              <>
                <img
                  src={imageUrl}
                  alt="Generated"
                  className="w-full h-full object-cover grayscale-[20%] group-hover:grayscale-0 transition-[filter] duration-700"
                  decoding="async"
                  onError={() => setImageFailed(true)}
                />
                <div className="absolute bottom-4 left-4 right-4 glass-panel rounded-xl p-3 flex justify-between items-center translate-y-12 opacity-0 group-hover:translate-y-0 group-hover:opacity-100 transition-all duration-300">
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        triggerImageDownload(imageUrl, t.common.downloadFilenamePrefix)
                      }
                      className="w-9 h-9 rounded-lg flex items-center justify-center bg-fill-selected hover:bg-accent-hover text-fg transition-colors"
                      title={t.chat.feed.download}
                    >
                      <Download size={16} />
                    </button>
                    <button
                      type="button"
                      className="w-9 h-9 rounded-lg flex items-center justify-center bg-fill-selected hover:bg-accent-hover text-fg transition-colors"
                      title={t.chat.feed.saveToGallery}
                    >
                      <Bookmark size={16} />
                    </button>
                  </div>
                  <button
                    type="button"
                    className="px-4 py-1.5 rounded-lg bg-accent-subtle hover:bg-accent-hover text-accent-fg text-xs font-bold transition-colors"
                  >
                    {t.chat.feed.regenerate}
                  </button>
                </div>
              </>
            )}
          </div>
        )}
        <ImageTurnMeta msg={msg} />
      </div>
    </div>
  );
}
