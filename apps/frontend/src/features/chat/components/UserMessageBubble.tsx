import type { Message } from '@mangostudio/shared';
import { format } from 'date-fns';
import { FileText, Image, ImageOff } from 'lucide-react';
import { useState } from 'react';
import { MarkdownContent } from '@/components/MarkdownContent';
import { useI18n } from '@/hooks/use-i18n';
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
  const { t } = useI18n();
  // Local to this row so a broken reference image never re-renders the feed.
  const [referenceImageFailed, setReferenceImageFailed] = useState(false);

  return (
    <>
      {msg.referenceImage && (
        <div className="mb-2 max-w-[200px] rounded-xl overflow-hidden border border-outline-variant/20 shadow-sm">
          {referenceImageFailed ? (
            <div className="w-full aspect-square bg-surface-container-high flex flex-col items-center justify-center text-on-surface-variant/50 p-4 text-center">
              <ImageOff size={24} className="mb-2" />
              <span className="text-[10px] font-label">{t.chat.feed.imageUnavailable}</span>
            </div>
          ) : (
            <ReservedAspectImage
              src={msg.referenceImage}
              alt="Reference"
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
                className="flex items-center gap-1.5 rounded-full border border-outline-variant/20 bg-surface-container-lowest px-2.5 py-1 text-[11px] text-on-surface-variant hover:text-on-surface transition-colors"
              >
                <FileText size={12} className="shrink-0 text-primary/70" />
                <span className="max-w-[12rem] truncate">{attachment.originalName}</span>
              </a>
            ))}
          </div>
        )}
        <div className="px-5 py-3 rounded-2xl bg-surface-container-low text-on-surface border border-outline-variant/10 font-body chat-message-body leading-relaxed">
          <MarkdownContent
            content={msg.text}
            copyCodeLabel={t.chat.copyCode}
            codeCopiedLabel={t.chat.codeCopied}
          />
        </div>
        {isImageTurn && (
          <span className="flex items-center gap-1 text-[10px] font-bold text-primary/70 font-label px-1">
            <Image size={11} />
            {t.chat.feed.createImageBadge}
          </span>
        )}
      </div>
      <span className="text-[10px] text-on-surface-variant font-label px-2">
        {format(msg.timestamp, 'h:mm a')}
      </span>
    </>
  );
}
