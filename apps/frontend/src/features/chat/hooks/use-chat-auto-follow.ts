import type { GeneratedImagePart, Message } from '@mangostudio/shared';
import type { RefObject, UIEvent } from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

const NEAR_BOTTOM_THRESHOLD_PX = 24;
/** Sub-pixel scroll positions drift by fractions; a real read-back moves more. */
const SCROLL_UP_THRESHOLD_PX = 1;

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
  /** Goes on the element that holds the transcript, not on the scroll port. */
  contentRef: RefObject<HTMLDivElement | null>;
  showScrollButton: boolean;
  handleScroll: (event: UIEvent<HTMLElement>) => void;
  scrollToBottom: () => void;
}

/**
 * Owns the chat feed's scroll-follow behavior: reset on chat switch, jump to the
 * newest message on load, keep the bottom in view while streaming, and surface a
 * "scroll to bottom" affordance once the user reads back through history.
 *
 * Usage: const { parentRef, contentRef, showScrollButton, handleScroll, scrollToBottom } =
 *   useChatAutoFollow(chatId, messages);
 */
export function useChatAutoFollow(chatId: string | null, messages: Message[]): ChatAutoFollow {
  const [showScrollButton, setShowScrollButton] = useState(false);
  const parentRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const shouldAutoFollowRef = useRef(true);
  const previousGeneratingIdRef = useRef<string | null>(null);
  const pendingScrollToBottomRef = useRef(true);
  const previousChatIdRef = useRef<string | null>(chatId);
  const lastScrollTopRef = useRef(0);

  const latestMessage = messages.at(-1);
  const latestMessageId = latestMessage?.id ?? null;
  const latestIsGenerating = latestMessage?.isGenerating ?? false;
  // Track content size as primitives so the streaming follow effect re-fires on
  // token growth without depending on the unstable message object reference.
  const latestPartsCount = latestMessage?.parts?.length ?? 0;
  const latestTextLen = latestMessage?.text?.length ?? 0;
  const latestImageSignature = imageCompletionSignature(latestMessage);
  const hasMessages = messages.length > 0;

  // Seeding the last known position with our own write is what keeps the
  // `scroll` event it queues from reading as the user jumping backwards.
  const followBottom = useCallback((element: HTMLElement) => {
    element.scrollTop = element.scrollHeight;
    lastScrollTopRef.current = element.scrollTop;
  }, []);

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
    if (!pendingScrollToBottomRef.current || !element || !hasMessages) return;
    followBottom(element);
    pendingScrollToBottomRef.current = false;
  }, [chatId, hasMessages, followBottom]);

  // Keep the bottom in view while the latest message streams. Layout effects run
  // before paint, so the pre-scroll frame is never visible.
  useLayoutEffect(() => {
    const isNewGeneratingMessage =
      latestIsGenerating && previousGeneratingIdRef.current !== latestMessageId;
    if (isNewGeneratingMessage) shouldAutoFollowRef.current = true;
    const element = parentRef.current;
    if (!latestIsGenerating || !element || !shouldAutoFollowRef.current) return;
    followBottom(element);
  }, [
    latestMessageId,
    latestIsGenerating,
    latestPartsCount,
    latestTextLen,
    latestImageSignature,
    followBottom,
  ]);

  // A part that grows *in place* moves none of the signals above: a thinking
  // delta rewrites `parts[i].text` and leaves both the part count and the
  // message text alone, and so does a tool result landing. The transcript's own
  // height is the one signal that covers every kind of growth, including the
  // rows a virtualizer re-measures after the fact.
  useEffect(() => {
    const element = parentRef.current;
    const content = contentRef.current;
    if (!element || !content) return;

    const observer = new ResizeObserver(() => {
      if (!shouldAutoFollowRef.current) return;
      followBottom(element);
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [hasMessages, followBottom]);

  useEffect(() => {
    previousGeneratingIdRef.current = latestIsGenerating ? latestMessageId : null;
  }, [latestMessageId, latestIsGenerating]);

  const handleScroll = useCallback((event: UIEvent<HTMLElement>) => {
    const element = event.currentTarget;
    const previousScrollTop = lastScrollTopRef.current;
    lastScrollTopRef.current = element.scrollTop;

    if (isNearBottom(element)) {
      shouldAutoFollowRef.current = true;
      setShowScrollButton(false);
      return;
    }
    // Only reading *back* stops the follow. Content growing below the viewport
    // also leaves the container short of its bottom, and a scroll event that
    // reports that gap is not the reader asking to be left where they are —
    // treating it as one is what stranded the feed mid-turn.
    if (element.scrollTop < previousScrollTop - SCROLL_UP_THRESHOLD_PX) {
      shouldAutoFollowRef.current = false;
    }
    // Suppress the button while auto-following so content growth (e.g. image
    // loads) cannot briefly flash it.
    setShowScrollButton(!shouldAutoFollowRef.current);
  }, []);

  const scrollToBottom = useCallback(() => {
    const element = parentRef.current;
    if (!element) return;
    shouldAutoFollowRef.current = true;
    setShowScrollButton(false);
    // Deliberately not seeding `lastScrollTopRef`: a smooth scroll walks the
    // position down over many frames, and every one of those events has to read
    // as forward motion rather than as a jump back from the target.
    element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' });
  }, []);

  return { parentRef, contentRef, showScrollButton, handleScroll, scrollToBottom };
}
