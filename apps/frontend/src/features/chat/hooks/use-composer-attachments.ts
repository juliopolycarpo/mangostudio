/**
 * Files reaching the composer by paste or drop, on top of the pending-list the
 * MCP resource menu already fills.
 *
 * Uploads are chat-scoped server-side, so this refuses before the request when
 * there is no chat yet — the same rule the MCP menu states in its own copy,
 * rather than a 404 the user has to interpret.
 */

import type { ChatAttachment } from '@mangostudio/shared/chat';
import { useCallback, useRef, useState } from 'react';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { uploadChatAttachment } from '@/services/attachment-service';

export interface ComposerAttachmentUploads {
  /** Names currently in flight, so the composer can say what it is waiting on. */
  readonly uploading: readonly string[];
  readonly error: string | null;
  readonly clearError: () => void;
  /** Uploads every file and hands the finished attachments to the caller. */
  readonly upload: (files: readonly File[]) => void;
}

export function useComposerAttachments(
  chatId: string | null,
  onUploaded: (attachments: ChatAttachment[]) => void
): ComposerAttachmentUploads {
  const { t } = useI18n();
  const labels = t.chat.input;
  const [uploading, setUploading] = useState<readonly string[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Read at call time so an upload started before a re-render still reports
  // into the current list rather than a captured one.
  const onUploadedRef = useRef(onUploaded);
  onUploadedRef.current = onUploaded;

  const upload = useCallback(
    (files: readonly File[]) => {
      if (files.length === 0) return;
      if (!chatId) {
        setError(labels.attachNeedsChat);
        return;
      }
      setError(null);
      const names = files.map((file) => file.name);
      setUploading((current) => [...current, ...names]);

      void Promise.allSettled(
        files.map(async (file) => {
          const attachment = await uploadChatAttachment(chatId, file);
          // Reported one at a time rather than batched at the end: a large PDF
          // beside a small screenshot should not hold the screenshot's chip off
          // the row until both land.
          onUploadedRef.current([attachment]);
          return file.name;
        })
      ).then((results) => {
        setUploading((current) => current.filter((name) => !names.includes(name)));
        const failed = names.filter((_, index) => results[index]?.status === 'rejected');
        // One message names one file; several name the count through the same
        // template, because listing five rejected filenames in a composer hint
        // is not something anyone reads.
        if (failed.length > 0) {
          setError(
            formatMessage(labels.attachFailed, {
              name: failed.length === 1 ? failed[0] : failed.join(', '),
            })
          );
        }
      });
    },
    [chatId, labels.attachFailed, labels.attachNeedsChat]
  );

  const clearError = useCallback(() => setError(null), []);
  return { uploading, error, clearError, upload };
}

/**
 * The files worth taking from a paste. A clipboard carrying formatted text
 * also carries an `text/html` item and, in some browsers, a rendered image of
 * the selection — pasting a copied paragraph must stay a paste, not an upload,
 * so only entries the platform typed as files count.
 */
export function filesFromClipboard(data: DataTransfer | null): File[] {
  if (!data) return [];
  const hasText = data.types.includes('text/plain');
  const files = Array.from(data.files);
  // Text alongside files is a rich-text paste; the text is the payload.
  return hasText && files.length > 0 && data.getData('text/plain').trim().length > 0 ? [] : files;
}
