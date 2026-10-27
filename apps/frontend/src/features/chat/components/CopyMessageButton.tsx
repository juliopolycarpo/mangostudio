import type { Message } from '@mangostudio/shared/chat';
import { Check, Copy } from 'lucide-react';

import { useClipboard } from '@/hooks/use-clipboard';
import { ICON_SM } from '@/lib/icon-sizes';
import { cn } from '@/lib/utils';

import { TURN_ACTION_REVEAL } from '../lib/turn-action-reveal';
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
      // Revealed with the turn's other actions. The negative margin keeps the
      // 24px target from making the separator row taller once the turn settles.
      className={cn(
        '-my-0.5 flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-sm text-fg-muted transition-colors hover:bg-fill-hover hover:text-fg',
        TURN_ACTION_REVEAL
      )}
      title={copied ? copiedLabel : label}
    >
      {copied ? <Check size={ICON_SM} className="text-success" /> : <Copy size={ICON_SM} />}
    </button>
  );
}
