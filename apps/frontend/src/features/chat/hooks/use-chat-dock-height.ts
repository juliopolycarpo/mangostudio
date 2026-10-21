import { type RefObject, useEffect, useRef } from 'react';

/**
 * Read by `WorkspaceRail`'s mobile trigger (`bottom-[calc(var(--chat-dock-height,…)…)]`),
 * which sits beside the composer rather than inside it and so cannot know how
 * tall the composer is.
 */
const DOCK_HEIGHT_PROPERTY = '--chat-dock-height';

interface ChatDockHeight {
  /** The element that publishes the property: the common ancestor of the dock and the rail. */
  readonly hostRef: RefObject<HTMLDivElement | null>;
  /** The element whose height is published: the notices and the composer under the transcript. */
  readonly dockRef: RefObject<HTMLDivElement | null>;
}

/**
 * Publishes the height of the chat's bottom dock (the notices and the composer)
 * as `--chat-dock-height` on a host element, so a control anchored to the
 * dock's top edge stays clear of it as the composer grows (a multi-line draft,
 * the expanded mobile controls) and shrinks.
 *
 * Written straight to the host's `style` rather than through state: the height
 * changes on every typed line, and a `setState` here would re-render the whole
 * chat page for a value only CSS reads. A zero height (nothing laid out yet)
 * clears the property, so the consumer's `var()` fallback applies.
 *
 * @example
 * const { hostRef, dockRef } = useChatDockHeight();
 * <div ref={hostRef}><main /><div ref={dockRef}><InputBar /></div></div>
 */
export function useChatDockHeight(): ChatDockHeight {
  const hostRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    const dock = dockRef.current;
    if (!host || !dock) return;

    const publish = () => {
      const height = dock.offsetHeight;
      if (height > 0) host.style.setProperty(DOCK_HEIGHT_PROPERTY, `${height}px`);
      else host.style.removeProperty(DOCK_HEIGHT_PROPERTY);
    };

    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(dock);
    return () => {
      observer.disconnect();
      host.style.removeProperty(DOCK_HEIGHT_PROPERTY);
    };
  }, []);

  return { hostRef, dockRef };
}
