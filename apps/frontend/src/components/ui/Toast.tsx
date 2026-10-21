import { CircleCheck, CircleX, Info, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import {
  createContext,
  type ReactNode,
  use,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { Button } from '@/components/ui/Button';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_LG, ICON_MD } from '@/lib/icon-sizes';
import { useMotionPresets } from '@/lib/motion/use-motion-presets';

interface Toast {
  id: string;
  message: string;
  type: 'success' | 'error' | 'info';
}

interface ToastContextValue {
  toast: (message: string, type?: Toast['type']) => void;
}

/** How long a toast stays when nobody is pointing at it or reading it. */
const AUTO_DISMISS_MS = 4000;

/**
 * One toast's auto-dismiss clock. It stops while the pointer is over the toast
 * or focus is inside it — a message the reader is reaching for must not vanish
 * under the cursor — and resumes with what was left, not a fresh four seconds.
 */
interface Countdown {
  timer: ReturnType<typeof setTimeout> | undefined;
  remaining: number;
  startedAt: number;
  hovered: boolean;
  focused: boolean;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const { fadeRise } = useMotionPresets();
  /**
   * Auto-dismiss clocks, keyed by toast id. They outlive the toast they were
   * scheduled for by up to 4s, so an unmount that leaves one pending fires
   * `setToasts` against a torn-down tree.
   */
  const countdowns = useRef(new Map<string, Countdown>());

  useEffect(() => {
    const pending = countdowns.current;
    return () => {
      for (const countdown of pending.values()) clearTimeout(countdown.timer);
      pending.clear();
    };
  }, []);

  const dismiss = useCallback((id: string) => {
    clearTimeout(countdowns.current.get(id)?.timer);
    countdowns.current.delete(id);
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const run = useCallback(
    (id: string) => {
      const countdown = countdowns.current.get(id);
      if (!countdown) return;
      countdown.startedAt = Date.now();
      countdown.timer = setTimeout(() => dismiss(id), countdown.remaining);
    },
    [dismiss]
  );

  const toast = useCallback(
    (message: string, type: Toast['type'] = 'info') => {
      const id = crypto.randomUUID();
      setToasts((prev) => [...prev, { id, message, type }]);
      countdowns.current.set(id, {
        timer: undefined,
        remaining: AUTO_DISMISS_MS,
        startedAt: 0,
        hovered: false,
        focused: false,
      });
      run(id);
    },
    [run]
  );

  /** Marks the pointer or focus as on (or off) a toast, stopping or resuming its clock. */
  const hold = useCallback(
    (id: string, source: 'hovered' | 'focused', on: boolean) => {
      const countdown = countdowns.current.get(id);
      if (!countdown) return;
      countdown[source] = on;
      if (countdown.hovered || countdown.focused) {
        if (countdown.timer === undefined) return;
        clearTimeout(countdown.timer);
        countdown.timer = undefined;
        countdown.remaining = Math.max(0, countdown.remaining - (Date.now() - countdown.startedAt));
      } else if (countdown.timer === undefined) {
        run(id);
      }
    },
    [run]
  );

  const typeIcons: Record<Toast['type'], ReactNode> = {
    success: <CircleCheck size={ICON_LG} className="text-success" aria-hidden="true" />,
    error: <CircleX size={ICON_LG} className="text-danger" aria-hidden="true" />,
    info: <Info size={ICON_LG} className="text-info" aria-hidden="true" />,
  };

  return (
    <ToastContext value={{ toast }}>
      {children}
      {/* A live region, so a toast is announced as it arrives rather than only
          seen: "Chat deleted" and "Could not delete the chat" are otherwise
          silent to a screen reader. An error is an `alert` on top of that.
          360px, the width components.md states, and never wider than the
          screen it sits on. */}
      {/* biome-ignore lint/a11y/useSemanticElements: a fixed overlay outside the page's outline. `section` is the page's own element for its content (the transcript is one), and a floating stack of notices is not another of its sections. */}
      <div
        role="region"
        aria-label={t.common.notifications}
        aria-live="polite"
        className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[min(22.5rem,calc(100vw-2rem))] flex-col gap-2"
      >
        <AnimatePresence initial={false}>
          {toasts.map((toastItem) => (
            <motion.div
              key={toastItem.id}
              {...fadeRise}
              role={toastItem.type === 'error' ? 'alert' : undefined}
              onMouseEnter={() => hold(toastItem.id, 'hovered', true)}
              onMouseLeave={() => hold(toastItem.id, 'hovered', false)}
              onFocus={() => hold(toastItem.id, 'focused', true)}
              onBlur={(event) => {
                // Focus moving between controls inside the toast is not leaving it.
                if (event.currentTarget.contains(event.relatedTarget)) return;
                hold(toastItem.id, 'focused', false);
              }}
              className="pointer-events-auto flex w-full items-start gap-3 rounded-md border border-stroke bg-surface-raised py-3 pl-4 pr-2 text-sm text-fg shadow-popover"
            >
              <span className="mt-0.5 shrink-0">{typeIcons[toastItem.type]}</span>
              <span className="min-w-0 flex-1 py-0.5">{toastItem.message}</span>
              <Button
                variant="subtle"
                size="icon"
                onClick={() => dismiss(toastItem.id)}
                aria-label={t.common.dismissToast}
                className="-my-1 size-7 shrink-0 text-fg-muted"
              >
                <X size={ICON_MD} />
              </Button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext>
  );
}

export function useToast() {
  const ctx = use(ToastContext);
  if (!ctx) throw new Error('useToast deve ser usado dentro de ToastProvider');
  return ctx;
}
