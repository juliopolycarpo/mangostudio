import type { Message } from '@mangostudio/shared';
import { Check, Copy } from 'lucide-react';
import { useClipboard } from '@/hooks/use-clipboard';
import { extractRawMarkdown } from './message-content';

interface CopyMessageButtonProps {
  msg: Message;
  label: string;
  copiedLabel: string;
}

/**
 * Copies a message's text to the clipboard with a transient "copied" state.
 *
 * Usage: <CopyMessageButton msg={msg} label={t.chat.copyMessage} copiedLabel={t.chat.messageCopied} />
 */
export function CopyMessageButton({ msg, label, copiedLabel }: CopyMessageButtonProps) {
  const { copy, copied } = useClipboard();

  const handleCopy = async () => {
    const text = extractRawMarkdown(msg);
    if (!text) return;
    await copy(text);
  };

  return (
    <button
      type="button"
      onClick={() => void handleCopy()}
      className="opacity-0 group-hover:opacity-70 hover:!opacity-100 transition-opacity duration-200 text-on-surface-variant/60 hover:text-on-surface-variant cursor-pointer"
      title={copied ? copiedLabel : label}
    >
      {copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
    </button>
  );
}
