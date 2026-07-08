import type { McpMediaPart } from '@mangostudio/shared';
import { Download, FileText, ImageOff, Plug } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '@/hooks/use-i18n';
import { triggerImageDownload } from '@/lib/download-image';
import { ReservedAspectImage } from './ReservedAspectImage';

interface Props {
  part: McpMediaPart;
}

/**
 * Renders one persisted MCP tool-result media part: images inline like
 * generated images, binary resources as a downloadable file chip.
 */
export function McpMediaPartBlock({ part }: Props) {
  const { t } = useI18n();
  const [loadError, setLoadError] = useState(false);
  const sourceLabel = `${part.serverSlug} · ${part.toolName}`;

  if (part.kind !== 'image') {
    return (
      <a
        href={part.url}
        target="_blank"
        rel="noreferrer"
        className="inline-flex max-w-md items-center gap-3 rounded-2xl border border-outline-variant/10 bg-surface-container-lowest px-4 py-3 transition-colors hover:bg-surface-container-high/50"
      >
        <FileText size={18} className="shrink-0 text-primary" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium text-on-surface">
            {part.uri ?? t.chat.feed.mcpResourceFile}
          </span>
          <span className="block truncate text-[10px] text-on-surface-variant/60">
            {t.chat.feed.mcpMediaSource.replace('{source}', sourceLabel)} · {part.mimeType}
          </span>
        </span>
        <Download size={14} className="shrink-0 text-on-surface-variant/60" />
      </a>
    );
  }

  if (loadError) {
    return (
      <div className="flex max-w-md flex-col items-center gap-3 rounded-2xl border border-outline-variant/10 bg-surface-container-low p-6 text-on-surface-variant/50">
        <ImageOff size={32} />
        <span className="text-xs font-body">{t.chat.feed.imageUnavailable}</span>
      </div>
    );
  }

  return (
    <div className="max-w-md overflow-hidden rounded-2xl border border-outline-variant/10 bg-surface-container-lowest shadow-sm">
      <div className="flex items-center gap-2.5 px-4 py-2.5">
        <Plug size={14} className="shrink-0 text-primary" />
        <span className="flex-1 truncate text-left text-xs font-body text-on-surface-variant/70">
          {t.chat.feed.mcpMediaSource.replace('{source}', sourceLabel)}
        </span>
      </div>
      <div className="group relative">
        <ReservedAspectImage
          src={part.url}
          alt={t.chat.feed.mcpImageAlt}
          className="bg-surface-container-high"
          objectFit="contain"
          onLoadError={() => setLoadError(true)}
        />
        <div className="absolute bottom-3 left-3 right-3 glass-panel rounded-xl p-2 flex justify-end items-center translate-y-12 opacity-0 group-hover:translate-y-0 group-hover:opacity-100 transition-all duration-300">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              triggerImageDownload(part.url, t.common.downloadFilenamePrefix);
            }}
            className="w-8 h-8 rounded-lg flex items-center justify-center bg-surface-container-highest/40 hover:bg-primary/20 text-on-surface transition-colors"
            title={t.chat.feed.download}
          >
            <Download size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
