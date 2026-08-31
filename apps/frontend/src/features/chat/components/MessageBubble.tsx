import type { ReactNode } from 'react';

interface MessageBubbleProps {
  children: ReactNode;
  /** Extra utilities for the balloon itself — width caps, mostly. */
  className?: string;
}

/**
 * The balloon a spoken message sits in, whoever spoke it.
 *
 * Alignment is deliberately not a prop: the row already decides which side a
 * turn hangs off (see `ChatMessageRow`), and a second authority here would
 * drift from it.
 *
 * Usage: <MessageBubble className="max-w-2xl"><MarkdownContent … /></MessageBubble>
 */
export function MessageBubble({ children, className }: MessageBubbleProps) {
  return (
    <div
      className={`px-5 py-3 rounded-2xl bg-surface-container-low text-on-surface border border-outline-variant/10 font-body chat-message-body leading-relaxed${className ? ` ${className}` : ''}`}
    >
      {children}
    </div>
  );
}
