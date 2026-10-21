import type { Message } from '@mangostudio/shared/chat';
import { FileText, Image, ImageOff } from 'lucide-react';
import { useState } from 'react';
import { MarkdownContent } from '@/components/MarkdownContent';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { useI18n } from '@/hooks/use-i18n';
import { formatClockTime } from '@/lib/i18n-format';
import { ICON_LG, ICON_SM } from '@/lib/icon-sizes';
import { MessageBubble } from './MessageBubble';
import { ReservedAspectImage } from './ReservedAspectImage';

interface UserMessageBubbleProps {
  msg: Message;
  isImageTurn: boolean;
}

/**
 * Renders a user-authored turn: optional reference image, the message text, an
 * image-mode badge, and the timestamp.
 *
 * Usage: <UserMessageBubble msg={msg} isImageTurn={isImageTurn} />
 */
export function UserMessageBubble({ msg, isImageTurn }: UserMessageBubbleProps) {
  const { t, locale } = useI18n();
  // Local to this row so a broken reference image never re-renders the feed.
  const [referenceImageFailed, setReferenceImageFailed] = useState(false);

  return (
    <>
      {msg.referenceImage && (
        <div className="mb-2 max-w-[200px] overflow-hidden rounded-md border border-stroke">
          {referenceImageFailed ? (
            <EmptyState
              icon={<ImageOff size={ICON_LG} />}
              title={t.chat.feed.imageUnavailable}
              className="aspect-square min-h-0 bg-surface"
            />
          ) : (
            <ReservedAspectImage
              src={msg.referenceImage}
              alt={t.chat.feed.referenceImageAlt}
              onLoadError={() => setReferenceImageFailed(true)}
            />
          )}
        </div>
      )}
      <div className="flex flex-col items-end gap-1.5">
        {msg.attachments && msg.attachments.length > 0 && (
          <div className="flex flex-wrap justify-end gap-1.5">
            {msg.attachments.map((attachment) => (
              <a
                key={attachment.id}
                href={attachment.url}
                target="_blank"
                rel="noreferrer"
                className="flex h-7 items-center gap-1.5 rounded-sm border border-stroke px-2 text-xs text-fg-muted transition-colors hover:bg-fill-hover hover:text-fg"
              >
                <FileText size={ICON_SM} className="shrink-0" />
                <span className="max-w-[12rem] truncate">{attachment.originalName}</span>
              </a>
            ))}
          </div>
        )}
        <MessageBubble>
          <MarkdownContent
            content={msg.text}
            copyCodeLabel={t.chat.copyCode}
            codeCopiedLabel={t.chat.codeCopied}
          />
        </MessageBubble>
        {isImageTurn && (
          <Badge>
            <Image size={ICON_SM} />
            {t.chat.feed.createImageBadge}
          </Badge>
        )}
      </div>
      <span className="px-1 font-mono text-micro text-fg-subtle">
        {formatClockTime(msg.timestamp, locale)}
      </span>
    </>
  );
}
