import { Spinner } from '@/components/ui/Spinner';

/**
 * The full-screen spinner shown while the app has nothing to render yet: the
 * session check, then (rarely) the startup locale's dictionary. It has no text,
 * so it needs no dictionary itself.
 *
 * Usage: `if (isPending) return <StartupSpinner />;`
 */
export function StartupSpinner() {
  return (
    <div
      className="flex min-h-screen items-center justify-center bg-canvas"
      data-testid="startup-spinner"
    >
      <Spinner size="md" />
    </div>
  );
}
