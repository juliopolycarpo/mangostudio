import type { GeneratedImagePart, Message } from '@mangostudio/shared';
import type { RefObject, UIEvent } from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

const NEAR_BOTTOM_THRESHOLD_PX = 24;

/** True when the scroll position sits within a small threshold of the bottom. */
export function isNearBottom(element: HTMLElement): boolean {
  return (
    element.scrollHeight - element.scrollTop - element.clientHeight <= NEAR_BOTTOM_THRESHOLD_PX
  );
}

/**
 * Captures a height-changing signal from the latest message's generated images.
 *
 * A generated image flipping `generating → completed` changes the row height
 * significantly, so we fold its status into a primitive the follow effect can
 * depend on without referencing the unstable message object.
 */
function imageCompletionSignature(message: Message | undefined): string {
  return (
    message?.parts
      ?.filter((p): p is GeneratedImagePart => p.type === 'generated_image')
      .map((p) => `${p.imageId}:${p.status}:${p.imageUrl ?? ''}`)
      .join(',') ?? ''
  );
}

export interface ChatAutoFollow {
  parentRef: RefObject<HTMLDivElement | null>;
  showScrollButton: boolean;
  handleScroll: (event: UIEvent<HTMLElement>) => void;
  scrollToBottom: () => void;
}

/**
 * Owns the chat feed's scroll-follow behavior: reset on chat switch, jump to the
 * newest message on load, keep the bottom in view while streaming, and surface a
 * "scroll to bottom" affordance once the user reads back through history.
 *
 * Usage: const { parentRef, showScrollButton, handleScroll, scrollToBottom } =
 *   useChatAutoFollow(chatId, messages);
 */
export function useChatAutoFollow(chatId: string | null, messages: Message[]): ChatAutoFollow {
  const [showScrollButton, setShowScrollButton] = useState(false);
  const parentRef = useRef<HTMLDivElement>(null);
  const shouldAutoFollowRef = useRef(true);
  const previousGeneratingIdRef = useRef<string | null>(null);
  const pendingScrollToBottomRef = useRef(true);
  const previousChatIdRef = useRef<string | null>(chatId);

  const latestMessage = messages.at(-1);
  const latestMessageId = latestMessage?.id ?? null;
  const latestIsGenerating = latestMessage?.isGenerating ?? false;
  // Track content size as primitives so the streaming follow effect re-fires on
  // token growth without depending on the unstable message object reference.
  const latestPartsCount = latestMessage?.parts?.length ?? 0;
  const latestTextLen = latestMessage?.text?.length ?? 0;
  const latestImageSignature = imageCompletionSignature(latestMessage);

  // Reset follow state when the user switches chats.
  useEffect(() => {
    if (previousChatIdRef.current === chatId) return;
    previousChatIdRef.current = chatId;
    shouldAutoFollowRef.current = true;
    pendingScrollToBottomRef.current = true;
  }, [chatId]);

  // Jump to the newest message once a chat's messages are present.
  useLayoutEffect(() => {
    const element = parentRef.current;
    if (!pendingScrollToBottomRef.current || !element || messages.length === 0) return;
    element.scrollTop = element.scrollHeight;
    pendingScrollToBottomRef.current = false;
  }, [chatId, messages.length]);

  // Keep the bottom in view while the latest message streams. Layout effects run
  // before paint, so the pre-scroll frame is never visible.
  useLayoutEffect(() => {
    const isNewGeneratingMessage =
      latestIsGenerating && previousGeneratingIdRef.current !== latestMessageId;
    if (isNewGeneratingMessage) shouldAutoFollowRef.current = true;
    const element = parentRef.current;
    if (!latestIsGenerating || !element || !shouldAutoFollowRef.current) return;
    element.scrollTop = element.scrollHeight;
  }, [latestMessageId, latestIsGenerating, latestPartsCount, latestTextLen, latestImageSignature]);

  useEffect(() => {
    previousGeneratingIdRef.current = latestIsGenerating ? latestMessageId : null;
  }, [latestMessageId, latestIsGenerating]);

  const handleScroll = useCallback((event: UIEvent<HTMLElement>) => {
    const nearBottom = isNearBottom(event.currentTarget);
    shouldAutoFollowRef.current = nearBottom;
    // Suppress the button while auto-following so content growth (e.g. image
    // loads) cannot briefly flash it.
    setShowScrollButton(!nearBottom);
  }, []);

  const scrollToBottom = useCallback(() => {
    const element = parentRef.current;
    if (!element) return;
    shouldAutoFollowRef.current = true;
    setShowScrollButton(false);
    element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' });
  }, []);

  return { parentRef, showScrollButton, handleScroll, scrollToBottom };
}
