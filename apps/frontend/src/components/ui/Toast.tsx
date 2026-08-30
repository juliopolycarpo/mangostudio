import { X } from 'lucide-react';
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
import { useI18n } from '@/hooks/use-i18n';
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

  const typeStyles: Record<Toast['type'], string> = {
    success: 'border-success/30 text-success',
    error: 'border-error/30 text-error',
    info: 'border-outline-variant/30 text-on-surface',
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
              className={`glass-panel pointer-events-auto flex items-center gap-3 px-4 py-3 rounded-xl border text-sm max-w-sm ${typeStyles[toastItem.type]}`}
            >
              <span className="flex-1">{toastItem.message}</span>
              <button
                type="button"
                onClick={() => dismiss(toastItem.id)}
                aria-label={t.common.dismissToast}
                className="shrink-0 opacity-50 hover:opacity-100 transition-opacity cursor-pointer"
              >
                <X size={14} />
              </button>
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
