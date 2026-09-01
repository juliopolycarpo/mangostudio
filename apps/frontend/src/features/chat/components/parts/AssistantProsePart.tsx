import { memo } from 'react';
import { MarkdownContent } from '@/components/MarkdownContent';
import { useI18n } from '@/hooks/use-i18n';
import { MessageBubble } from '../MessageBubble';

interface AssistantProsePartProps {
  text: string;
  /** True only while this part is the one being streamed into. */
  isStreaming: boolean;
  /** Set when the turn ended before the sentence did. */
  incomplete?: true;
}

/**
 * The prose an assistant turn wrote, rendered as markdown in the same balloon a
 * user's own message gets — the visible break between what the agent did and
 * what it said.
 *
 * A tool-interleaved turn splits prose into one part per contiguous run, so a
 * turn with several tool calls mounts several of these. Memoized because every
 * settled run's props are unchanged by a delta landing in a later part of the
 * same turn.
 *
 * // Usage: <AssistantProsePart text={part.text} isStreaming={false} />
 */
function AssistantProsePartComponent({ text, isStreaming, incomplete }: AssistantProsePartProps) {
  const { t } = useI18n();
  return (
    <MessageBubble className="max-w-2xl">
      {/* Vendor prose goes through the same renderer as a MangoStudio turn's. A
          vendor writes markdown because it assumes a terminal renders it, so
          plain text showed its `##` and `**` raw. The renderer — not the caller
          — is the trust boundary: raw html is escaped, link and image targets
          are scheme-checked, and an image is downgraded to an anchor, so no
          vendor markup reaches the DOM live. */}
      <MarkdownContent
        content={text}
        isStreaming={isStreaming}
        copyCodeLabel={t.chat.copyCode}
        codeCopiedLabel={t.chat.codeCopied}
      />
      {incomplete ? (
        <span className="mt-1 block text-xs italic text-on-surface-variant/50">
          {t.externalAgents.turn.incomplete}
        </span>
      ) : null}
    </MessageBubble>
  );
}

export const AssistantProsePart = memo(AssistantProsePartComponent);
