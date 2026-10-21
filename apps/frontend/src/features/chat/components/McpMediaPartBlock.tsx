import type { McpMediaPart } from '@mangostudio/shared/types';
import { Download, FileText, ImageOff, Plug } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { useI18n } from '@/hooks/use-i18n';
import { triggerImageDownload } from '@/lib/download-image';
import { ICON_LG, ICON_MD, ICON_SM } from '@/lib/icon-sizes';
import { ImageActionBar } from './ImageActionBar';
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
        className="inline-flex max-w-md items-center gap-3 rounded-md border border-stroke bg-control px-4 py-3 transition-colors hover:bg-control-hover"
      >
        <FileText size={ICON_LG} className="shrink-0 text-fg-muted" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium text-fg">
            {part.uri ?? t.chat.feed.mcpResourceFile}
          </span>
          <span className="block truncate font-mono text-micro text-fg-subtle">
            {t.chat.feed.mcpMediaSource.replace('{source}', sourceLabel)} · {part.mimeType}
          </span>
        </span>
        <Download size={ICON_SM} className="shrink-0 text-fg-muted" />
      </a>
    );
  }

  if (loadError) {
    return (
      <EmptyState
        icon={<ImageOff size={ICON_LG} />}
        title={t.chat.feed.imageUnavailable}
        className="max-w-(--timeline-card-max) rounded-md border border-stroke bg-surface"
      />
    );
  }

  return (
    <div className="max-w-md overflow-hidden rounded-md border border-stroke bg-surface">
      <div className="flex h-8 items-center gap-2 px-3">
        <Plug size={ICON_SM} className="shrink-0 text-fg-muted" />
        <span className="flex-1 truncate text-left text-xs text-fg-muted">
          {t.chat.feed.mcpMediaSource.replace('{source}', sourceLabel)}
        </span>
      </div>
      <div className="group relative">
        <ReservedAspectImage
          src={part.url}
          alt={t.chat.feed.mcpImageAlt}
          className="bg-canvas"
          objectFit="contain"
          onLoadError={() => setLoadError(true)}
        />
        <ImageActionBar className="justify-end">
          <Button
            variant="subtle"
            size="icon"
            onClick={(e) => {
              e.stopPropagation();
              triggerImageDownload(part.url, t.common.downloadFilenamePrefix);
            }}
            title={t.chat.feed.download}
          >
            <Download size={ICON_MD} />
          </Button>
        </ImageActionBar>
      </div>
    </div>
  );
}
