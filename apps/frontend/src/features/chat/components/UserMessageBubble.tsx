import type { Message } from '@mangostudio/shared/chat';
import { FileText, Image, ImageOff } from 'lucide-react';
import { useState } from 'react';

import { MarkdownContent } from '@/components/MarkdownContent';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { useI18n } from '@/hooks/use-i18n';
import { formatClockTime } from '@/lib/i18n-format';
import { ICON_LG, ICON_SM } from '@/lib/icon-sizes';
import { cn } from '@/lib/utils';

import { MessageBubble } from './MessageBubble';
import { ReservedAspectImage } from './ReservedAspectImage';

/** A message's attachment as the transcript carries it, whose `kind` stays open to values this build predates. */
type MessageAttachment = NonNullable<Message['attachments']>[number];

interface UserMessageBubbleProps {
  msg: Message;
  isImageTurn: boolean;
}

function isImageAttachment(attachment: MessageAttachment): boolean {
  return attachment.kind === 'image' || attachment.mimeType.startsWith('image/');
}

/** A file that is not a picture, or a picture that would not load: its name, as a link. */
function AttachmentChip({ attachment }: { attachment: MessageAttachment }) {
  return (
    <a
      href={attachment.url}
      target="_blank"
      rel="noreferrer"
      className="flex h-7 items-center gap-1.5 rounded-sm border border-stroke px-2 text-xs text-fg-muted transition-colors hover:bg-fill-hover hover:text-fg"
    >
      <FileText size={ICON_SM} className="shrink-0" />
      <span className="max-w-[12rem] truncate">{attachment.originalName}</span>
    </a>
  );
}

/**
 * A picture the user attached, drawn as the picture rather than as a document
 * icon with its file name. 56px, so a few of them sit on the bubble's top edge
 * without becoming the message.
 */
function AttachmentThumbnail({ attachment }: { attachment: MessageAttachment }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <AttachmentChip attachment={attachment} />;
  return (
    <a
      href={attachment.url}
      target="_blank"
      rel="noreferrer"
      title={attachment.originalName}
      className="block size-14 shrink-0 overflow-hidden rounded-xs border border-stroke bg-canvas"
    >
      <img
        src={attachment.url}
        alt={attachment.originalName}
        className="size-full object-cover"
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
      />
    </a>
  );
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
  const images = (msg.attachments ?? []).filter(isImageAttachment);
  const files = (msg.attachments ?? []).filter((attachment) => !isImageAttachment(attachment));

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
        {files.length > 0 && (
          <div className="flex flex-wrap justify-end gap-1.5">
            {files.map((attachment) => (
              <AttachmentChip key={attachment.id} attachment={attachment} />
            ))}
          </div>
        )}
        <MessageBubble>
          {/* On the bubble's own top edge: the pictures are part of what was said,
              not a separate object floating above it. */}
          {images.length > 0 && (
            <div className={cn('flex flex-wrap gap-1.5', msg.text && 'mb-3')}>
              {images.map((attachment) => (
                <AttachmentThumbnail key={attachment.id} attachment={attachment} />
              ))}
            </div>
          )}
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
      <span className="font-mono text-micro text-fg-subtle">
        {formatClockTime(msg.timestamp, locale)}
      </span>
    </>
  );
}
