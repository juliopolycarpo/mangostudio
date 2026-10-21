import { Spinner } from '@/components/ui/Spinner';
import { detectLocale, localeDictionaries } from '@/lib/locale-dictionaries';

/**
 * The full-screen spinner shown while the app has nothing to render yet: the
 * session check, then (rarely) the startup locale's dictionary.
 *
 * It names itself to assistive technology, which a bare ring cannot do. The
 * dictionary may be the very thing it is waiting for, so the name is read from
 * the store directly: the startup locale's, once it has landed, and the eager
 * English one until then — a status line a screen reader hears for a moment is
 * better said in the wrong language than not said at all.
 *
 * Usage: `if (isPending) return <StartupSpinner />;`
 */
export function StartupSpinner() {
  const label = (localeDictionaries.resolved(detectLocale()) ?? localeDictionaries.resolved('en'))
    ?.messages.common.loading;

  return (
    <div
      role="status"
      className="flex min-h-screen items-center justify-center bg-canvas"
      data-testid="startup-spinner"
    >
      <Spinner size="md" />
      {label ? <span className="sr-only">{label}</span> : null}
    </div>
  );
}
