import { Download, AlertCircle, Image, ImageOff } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '@/hooks/use-i18n';
import type { GeneratedImagePart as GeneratedImagePartType } from '@mangostudio/shared';

interface Props {
  part: GeneratedImagePartType;
}

export function GeneratedImagePart({ part }: Props) {
  const { t } = useI18n();
  const [loadError, setLoadError] = useState(false);

  if (part.status === 'completed' && part.imageUrl && !loadError) {
    const imageUrl = part.imageUrl;
    return (
      <div className="group relative bg-surface-container-lowest rounded-2xl overflow-hidden border border-outline-variant/10 shadow-sm max-w-md">
        <img
          src={imageUrl}
          alt={t.chat.feed.generatedImageAlt}
          className="w-full h-auto object-cover"
          loading="lazy"
          onError={() => setLoadError(true)}
        />
        <div className="absolute bottom-3 left-3 right-3 glass-panel rounded-xl p-2 flex justify-between items-center translate-y-12 opacity-0 group-hover:translate-y-0 group-hover:opacity-100 transition-all duration-300">
          <button
            type="button"
            onClick={() => {
              const link = document.createElement('a');
              link.href = imageUrl;
              link.download = `mango-art-${Date.now()}.png`;
              document.body.appendChild(link);
              link.click();
              document.body.removeChild(link);
            }}
            className="w-8 h-8 rounded-lg flex items-center justify-center bg-surface-container-highest/40 hover:bg-primary/20 text-on-surface transition-colors"
            title={t.chat.feed.download}
          >
            <Download size={14} />
          </button>
        </div>
      </div>
    );
  }

  if (part.status === 'completed' && loadError) {
    return (
      <div className="bg-surface-container-low rounded-2xl border border-outline-variant/10 p-6 flex flex-col items-center gap-3 text-on-surface-variant/50 max-w-md">
        <ImageOff size={32} />
        <span className="text-xs font-body">{t.chat.feed.imageUnavailable}</span>
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
        </div>
      </div>
    );
  }

  return (
    <div className="bg-surface-container-lowest border border-outline-variant/10 rounded-2xl p-5 flex flex-col gap-3 max-w-md animate-pulse">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-surface-container-high flex items-center justify-center">
          <Image size={20} className="text-primary/50" />
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-on-surface">{t.chat.feed.generatingImage}</span>
          <span className="text-[10px] text-on-surface-variant/50 font-body">{part.prompt}</span>
        </div>
      </div>
      <div className="h-1 w-full bg-surface-container-high rounded-full overflow-hidden">
        <div className="h-full bg-primary w-1/3 rounded-full animate-[slide_1.5s_ease-in-out_infinite_alternate]" />
      </div>
    </div>
  );
}
