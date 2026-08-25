import type { GeneratedImagePart, Message } from '@mangostudio/shared';
import type { RefObject, UIEvent } from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

const NEAR_BOTTOM_THRESHOLD_PX = 24;
/** Sub-pixel scroll positions drift by fractions; a real read-back moves more. */
const SCROLL_UP_THRESHOLD_PX = 1;
/**
 * How long a pointer, wheel or touch keeps counting as the reader driving.
 *
 * Long enough to cover trackpad momentum, which keeps emitting `scroll` after
 * the fingers are gone; each attributed frame pushes the window out again, so a
 * fling stays one gesture rather than becoming a gesture and then a mystery.
 */
const GESTURE_WINDOW_MS = 700;
/**
 * Input that means a person is moving the view, rather than layout moving it.
 *
 * `keydown` is here for PageUp/Home/arrows, which bubble up from whatever inside
 * the transcript has focus. The composer is a sibling of the scroll port, not a
 * descendant, so typing a prompt never reaches this.
 */
const GESTURE_EVENTS = ['wheel', 'touchmove', 'pointerdown', 'keydown'] as const;

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
  const lastGestureAtRef = useRef(Number.NEGATIVE_INFINITY);

  const latestMessage = messages.at(-1);
  const latestMessageId = latestMessage?.id ?? null;
  const latestIsGenerating = latestMessage?.isGenerating ?? false;
  // Track content size as primitives so the streaming follow effect re-fires on
  // token growth without depending on the unstable message object reference.
  const latestPartsCount = latestMessage?.parts?.length ?? 0;
  const latestTextLen = latestMessage?.text?.length ?? 0;
  const latestImageSignature = imageCompletionSignature(latestMessage);
  const hasMessages = messages.length > 0;

  /**
   * Pins the container to its bottom and reports whether it got there.
   *
   * It often cannot on first paint: a virtualizer that has measured six rows of
   * forty reports a fraction of the real height, and the jump lands thousands
   * of pixels short. So reaching the bottom — not attempting it — is what
   * settles the pending jump.
   */
  const followBottom = useCallback((element: HTMLElement) => {
    element.scrollTop = element.scrollHeight;
    // Seeding the last known position with our own write keeps the `scroll`
    // event it queues from reading as the reader jumping backwards.
    lastScrollTopRef.current = element.scrollTop;
    const landed = isNearBottom(element);
    if (landed) pendingScrollToBottomRef.current = false;
    return landed;
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
  // rows a virtualizer re-measures after the fact — which is also what finishes
  // the initial jump the first paint could not.
  useEffect(() => {
    const element = parentRef.current;
    const content = contentRef.current;
    if (!element || !content) return;

    const observer = new ResizeObserver(() => {
      if (!shouldAutoFollowRef.current && !pendingScrollToBottomRef.current) return;
      followBottom(element);
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [hasMessages, followBottom]);

  // Separates a reader moving the view from the browser re-clamping it. A
  // virtualized transcript re-lays itself out as rows mount and measure, and
  // the browser reports each of those clamps as an ordinary `scroll` event —
  // indistinguishable from a wheel except that no input preceded it. Reading
  // one as intent is what left a freshly opened chat stranded at the top.
  useEffect(() => {
    const element = parentRef.current;
    if (!element) return;
    const markGesture = () => {
      lastGestureAtRef.current = performance.now();
    };
    for (const name of GESTURE_EVENTS) {
      element.addEventListener(name, markGesture, { passive: true });
    }
    return () => {
      for (const name of GESTURE_EVENTS) element.removeEventListener(name, markGesture);
    };
  }, []);

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
    // Reading back stops the follow, and only the reader can do it. Content
    // growing below the viewport leaves the same gap, and so does a re-layout
    // clamping the position — neither is a request to be left where they are.
    const drivenByReader = performance.now() - lastGestureAtRef.current < GESTURE_WINDOW_MS;
    if (drivenByReader) lastGestureAtRef.current = performance.now();
    if (drivenByReader && element.scrollTop < previousScrollTop - SCROLL_UP_THRESHOLD_PX) {
      shouldAutoFollowRef.current = false;
      // The reader has taken over, so the chat is no longer owed its opening
      // jump — finishing it later would yank them out of what they scrolled to.
      pendingScrollToBottomRef.current = false;
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
