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

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const { fadeRise } = useMotionPresets();
  /**
   * Auto-dismiss timers, keyed by toast id. They outlive the toast they were
   * scheduled for by up to 4s, so an unmount that leaves one pending fires
   * `setToasts` against a torn-down tree.
   */
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  const dismiss = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback((message: string, type: Toast['type'] = 'info') => {
    const id = crypto.randomUUID();
    setToasts((prev) => [...prev, { id, message, type }]);
    timers.current.set(
      id,
      setTimeout(() => {
        timers.current.delete(id);
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 4000)
    );
  }, []);

  const typeIcons: Record<Toast['type'], ReactNode> = {
    success: <CircleCheck size={ICON_LG} className="text-success" aria-hidden="true" />,
    error: <CircleX size={ICON_LG} className="text-danger" aria-hidden="true" />,
    info: <Info size={ICON_LG} className="text-info" aria-hidden="true" />,
  };

  return (
    <ToastContext value={{ toast }}>
      {children}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
        <AnimatePresence initial={false}>
          {toasts.map((toastItem) => (
            <motion.div
              key={toastItem.id}
              {...fadeRise}
              className="pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-md border border-stroke bg-surface-raised py-3 pl-4 pr-2 text-sm text-fg shadow-popover"
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
