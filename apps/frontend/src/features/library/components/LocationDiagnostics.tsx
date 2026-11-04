import type { LibraryLocationDiagnostic } from '@mangostudio/shared/library';

import { useI18n } from '@/hooks/use-i18n';

export function LocationDiagnostics({
  diagnostics,
}: {
  readonly diagnostics: readonly LibraryLocationDiagnostic[] | undefined;
}) {
  const { t } = useI18n();
  const l = t.library.scanDiagnostics;
  if (diagnostics?.length === 0) return null;
  return (
    <section className="space-y-2 rounded-md border border-stroke bg-surface p-4">
      {diagnostics === undefined ? (
        <p className="text-fg-muted text-sm">{l.legacy}</p>
      ) : (
        <>
          <h2 className="font-semibold text-fg text-sm">{l.heading}</h2>
          <ul className="space-y-2">
            {diagnostics.map((diagnostic) => (
              <li key={diagnostic.locationId} className="text-fg-muted text-sm">
                <span className="font-mono">{diagnostic.locationId}</span>:{' '}
                {l.reason[diagnostic.reason]}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
