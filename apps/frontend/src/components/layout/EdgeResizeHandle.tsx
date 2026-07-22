import { type KeyboardEvent, type PointerEvent, useRef } from 'react';

const RESIZE_STEP = 16;

export interface EdgeResizeHandleProps {
  readonly width: number;
  readonly min: number;
  readonly max: number;
  readonly label: string;
  /** Which edge the handle sits on. Dragging toward the opposite side grows the pane. */
  readonly edge: 'left' | 'right';
  readonly onResize: (width: number) => void;
  readonly onResizeEnd: () => void;
}

/**
 * Accessible vertical resize handle shared by the chat sidebar and workspace rail.
 * Persists on pointer-up / key-up / blur so keyboard repeats and drag previews do not
 * spam settings writes.
 */
export function EdgeResizeHandle({
  width,
  min,
  max,
  label,
  edge,
  onResize,
  onResizeEnd,
}: EdgeResizeHandleProps) {
  const dragRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const keyboardResizedRef = useRef(false);

  const clamp = (next: number) => Math.min(max, Math.max(min, Math.round(next)));

  const handlePointerDown = (event: PointerEvent<HTMLHRElement>) => {
    if (event.button !== 0) return;
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const handlePointerMove = (event: PointerEvent<HTMLHRElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const delta = event.clientX - drag.startX;
    // A right-edge handle grows when dragged right; a left-edge handle grows when dragged left.
    onResize(clamp(drag.startWidth + (edge === 'right' ? delta : -delta)));
  };

  /**
   * Also wired to `pointercancel`/`lostpointercapture`: without them an interrupted
   * drag would leave `dragRef` populated, and the next hover over the handle would
   * resize with no button held down.
   */
  const endDrag = (event: PointerEvent<HTMLHRElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    onResizeEnd();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLHRElement>) => {
    let nextWidth: number | null = null;
    if (event.key === 'ArrowLeft') {
      nextWidth = clamp(width + (edge === 'left' ? RESIZE_STEP : -RESIZE_STEP));
    }
    if (event.key === 'ArrowRight') {
      nextWidth = clamp(width + (edge === 'right' ? RESIZE_STEP : -RESIZE_STEP));
    }
    if (event.key === 'Home') nextWidth = min;
    if (event.key === 'End') nextWidth = max;
    if (nextWidth === null) return;
    event.preventDefault();
    keyboardResizedRef.current = true;
    onResize(nextWidth);
  };

  // Held arrow keys resize live but persist once, so a repeat burst is one settings write.
  const endKeyboardResize = () => {
    if (!keyboardResizedRef.current) return;
    keyboardResizedRef.current = false;
    onResizeEnd();
  };

  const positionClass = edge === 'right' ? 'right-0 translate-x-1/2' : 'left-0 -translate-x-1/2';

  return (
    <>
      <hr
        aria-orientation="vertical"
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={width}
        tabIndex={0}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
        onKeyDown={handleKeyDown}
        onKeyUp={endKeyboardResize}
        onBlur={endKeyboardResize}
        // `h-auto` beats the Tailwind preflight `hr { height: 0 }`, which would otherwise
        // override the `inset-y-0` stretch and leave a 0px-tall, unhittable handle.
        className={`peer absolute inset-y-0 z-10 m-0 h-auto w-2 cursor-col-resize touch-none border-0 bg-transparent transition-colors hover:bg-primary/15 focus-visible:bg-primary/20 focus-visible:outline-none ${positionClass}`}
      />
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute top-1/2 z-10 h-12 w-1 -translate-y-1/2 rounded-full bg-outline-variant/50 transition-colors peer-hover:bg-primary/70 peer-focus-visible:bg-primary/70 ${positionClass}`}
      />
    </>
  );
}
