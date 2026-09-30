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
      className="min-h-screen bg-surface-dim flex items-center justify-center"
      data-testid="startup-spinner"
    >
      <div className="w-6 h-6 rounded-full border-2 border-primary border-t-transparent animate-spin" />
    </div>
  );
}
