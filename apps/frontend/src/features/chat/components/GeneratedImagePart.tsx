import type { GeneratedImagePart as GeneratedImagePartType } from '@mangostudio/shared';
import {
  AlertCircle,
  Bookmark,
  ChevronDown,
  Download,
  Image,
  ImageOff,
  Sparkles,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';
import { useI18n } from '@/hooks/use-i18n';
import { triggerImageDownload } from '@/lib/download-image';
import { useMotionPresets } from '@/lib/motion/use-motion-presets';
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
    part.prompt && part.prompt.length > 80 ? `${part.prompt.slice(0, 80)}\u2026` : part.prompt;

  const generationTimeLabel = part.generationTime
    ? t.chat.feed.thoughtFor.replace('{time}', part.generationTime)
    : null;

  const modelLabel = part.modelName ?? null;

  if (part.status === 'completed' && part.imageUrl && !loadError) {
    const imageUrl = part.imageUrl;

    return (
      <div className="bg-surface-container-lowest rounded-2xl overflow-hidden border border-outline-variant/10 shadow-sm max-w-md">
        {/* Header */}
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          className="w-full flex items-center gap-2.5 px-4 py-2.5 hover:bg-surface-container-high/50 transition-colors cursor-pointer"
        >
          <Image size={14} className="text-primary shrink-0" />
          <span className="text-xs text-on-surface-variant/70 font-body truncate flex-1 text-left">
            {promptSnippet || t.chat.feed.generatedImageAlt}
          </span>
          <ChevronDown
            size={14}
            className={`text-on-surface-variant/40 shrink-0 transition-transform duration-300 ${collapsed ? '' : 'rotate-180'}`}
          />
        </button>

        <AnimatePresence initial={false}>
          {!collapsed && (
            <motion.div key="image-content" {...collapse}>
              {/* Meta bar: model + generation time */}
              {(modelLabel || generationTimeLabel) && (
                <div className="flex items-center gap-2 flex-wrap px-4 pb-2">
                  {modelLabel && (
                    <span className="text-[10px] text-on-surface-variant/60 font-mono bg-surface-container-high px-2 py-0.5 rounded-full">
                      {modelLabel}
                    </span>
                  )}
                  {generationTimeLabel && (
                    <span className="flex items-center gap-1 text-[10px] text-on-surface-variant/60">
                      <Sparkles size={10} className="text-primary/50" />
                      {generationTimeLabel}
                    </span>
                  )}
                </div>
              )}

              <div className="group relative">
                <ReservedAspectImage
                  src={imageUrl}
                  alt={t.chat.feed.generatedImageAlt}
                  className="bg-surface-container-high"
                  objectFit="contain"
                  onLoadError={() => setLoadError(true)}
                />
                <div className="absolute bottom-3 left-3 right-3 glass-panel rounded-xl p-2 flex justify-between items-center translate-y-12 opacity-0 group-hover:translate-y-0 group-hover:opacity-100 transition-all duration-300">
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        triggerImageDownload(imageUrl, t.common.downloadFilenamePrefix);
                      }}
                      className="w-8 h-8 rounded-lg flex items-center justify-center bg-surface-container-highest/40 hover:bg-primary/20 text-on-surface transition-colors"
                      title={t.chat.feed.download}
                    >
                      <Download size={14} />
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        triggerImageDownload(imageUrl, t.common.downloadFilenamePrefix);
                      }}
                      className="w-8 h-8 rounded-lg flex items-center justify-center bg-surface-container-highest/40 hover:bg-primary/20 text-on-surface transition-colors"
                      title={t.chat.feed.saveToGallery}
                    >
                      <Bookmark size={14} />
                    </button>
                  </div>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    );
  }

  if (part.status === 'completed' && loadError) {
    return (
      <div className="bg-surface-container-low rounded-2xl border border-outline-variant/10 p-6 flex flex-col items-center gap-3 text-on-surface-variant/50 max-w-md">
        <ImageOff size={32} />
        <span className="text-xs font-body">{t.chat.feed.imageUnavailable}</span>
        {modelLabel && (
          <span className="text-[10px] text-on-surface-variant/40 font-mono">{modelLabel}</span>
        )}
      </div>
    );
  }

  if (part.status === 'error') {
    return (
      <div className="bg-error/10 border border-error/20 p-4 rounded-xl flex items-start gap-3 max-w-md">
        <AlertCircle size={16} className="text-error shrink-0 mt-0.5" />
        <div className="flex flex-col gap-1 min-w-0">
          <span className="text-error text-xs font-bold">{t.chat.feed.imageGenerationFailed}</span>
          {part.error && (
            <span className="text-error/70 text-[11px] font-body leading-relaxed">
              {part.error}
            </span>
          )}
          {(modelLabel || generationTimeLabel) && (
            <span className="text-error/40 text-[10px] font-mono mt-0.5">
              {[modelLabel, generationTimeLabel].filter(Boolean).join(' \u00b7 ')}
            </span>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="bg-surface-container-lowest border border-outline-variant/10 rounded-2xl p-5 flex flex-col gap-3 max-w-md animate-pulse">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-surface-container-high flex items-center justify-center shrink-0">
          <Image size={20} className="text-primary/50 shrink-0" />
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-on-surface">
            {modelLabel
              ? t.chat.feed.modelStatus
                  .replace('{status}', t.chat.feed.statusGenerating)
                  .replace('{model}', () => modelLabel)
              : t.chat.feed.generatingImage}
          </span>
          <span className="text-[10px] text-on-surface-variant/50 font-body">{part.prompt}</span>
        </div>
      </div>
      {/* Reserve square aspect space so the skeleton is close in height to
          the completed image. Prevents a large row-size jump in the virtual
          feed when the status flips to completed. */}
      <div className="aspect-square bg-surface-container-high rounded-xl" />
      <div className="h-1 w-full bg-surface-container-high rounded-full overflow-hidden">
        <div className="h-full bg-primary w-1/3 rounded-full animate-[slide_1s_ease-in-out_infinite_alternate]" />
      </div>
    </div>
  );
}
