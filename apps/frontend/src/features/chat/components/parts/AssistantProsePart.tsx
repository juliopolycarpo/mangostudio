import { MarkdownContent } from '@/components/MarkdownContent';
import { useI18n } from '@/hooks/use-i18n';

interface AssistantProsePartProps {
  text: string;
  /** True only while this part is the one being streamed into. */
  isStreaming: boolean;
  /** Set when the turn ended before the sentence did. */
  incomplete?: true;
}

/**
 * The prose an assistant turn wrote, rendered as markdown.
 *
 * // Usage: <AssistantProsePart text={part.text} isStreaming={false} />
 */
export function AssistantProsePart({ text, isStreaming, incomplete }: AssistantProsePartProps) {
  const { t } = useI18n();
  return (
    <div className="chat-message-body max-w-2xl font-body leading-relaxed text-on-surface">
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
    </div>
  );
}
