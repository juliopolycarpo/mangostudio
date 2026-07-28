/**
 * One kind tab: filters, the matrix, and the bulk action that turns a row
 * selection into a single propagation review.
 *
 * Six skills going to Cursor is one review, not six — the selection is the unit
 * of work, and the wizard opens once for the whole set.
 */

import type { LibraryLocationId, ResourceKind } from '@mangostudio/shared/library';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { useLibraryMatrix } from '../hooks/use-library-matrix';
import { CoverageMatrix, MatrixLegend } from './CoverageMatrix';
import { LibraryPageState } from './LibraryPageState';
import { MatrixFilters } from './MatrixFilters';
import { PropagationWizard } from './PropagationWizard';

export function MatrixPage({ kind }: { readonly kind: ResourceKind }) {
  const { t } = useI18n();
  const l = t.library;
  const matrix = useLibraryMatrix(kind);
  const [wizardKeys, setWizardKeys] = useState<readonly string[] | null>(null);

  /**
   * Every enabled location storing this kind is previewed, not only the ones
   * the user might pick: the destination step needs the full list to say what a
   * location is blocked by, and a location absent from the preview cannot be
   * explained at all.
   */
  const candidateLocationIds = useMemo<LibraryLocationId[]>(
    () =>
      matrix.locations
        .filter((location) => location.kind === kind && location.path !== null)
        .map((location) => location.id),
    [matrix.locations, kind]
  );

  if (matrix.isPending && matrix.resources.length === 0) {
    return <LibraryPageState variant="loading" />;
  }
  if (matrix.error && matrix.resources.length === 0) {
    return <LibraryPageState variant="error" onRetry={matrix.refetch} />;
  }

  const selectedCount = matrix.selected.size;

  return (
    <div className="space-y-4">
      <MatrixFilters
        filters={matrix.filters}
        targets={matrix.targets}
        locations={matrix.locations}
        onChange={matrix.setFilters}
      />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <MatrixLegend />
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={matrix.rescan} disabled={matrix.isRescanning}>
            {matrix.isRescanning ? l.matrix.rescanning : l.matrix.rescan}
          </Button>
          {selectedCount > 0 && (
            <>
              <span className="text-on-surface-variant text-xs" data-testid="selected-count">
                {formatMessage(l.matrix.selectedCount, { count: String(selectedCount) })}
              </span>
              <Button variant="ghost" size="sm" onClick={matrix.clearSelection}>
                {l.matrix.clearSelection}
              </Button>
              <Button size="sm" onClick={() => setWizardKeys([...matrix.selected])}>
                {l.matrix.propagate}
              </Button>
            </>
          )}
        </div>
      </div>

      {/*
        The matrix renders even with nothing in it. The column set is the answer
        to "which agents am I looking at", and it does not depend on which rows
        survived a filter — or on whether this machine has any resources at all.
      */}
      <CoverageMatrix
        groups={matrix.groups}
        targets={matrix.targets}
        locations={matrix.locations}
        selected={matrix.selected}
        onToggleSelected={matrix.toggleSelected}
        onToggleAll={matrix.toggleAllVisible}
      />

      {matrix.resources.length === 0 ? (
        <LibraryPageState variant="empty" title={l.matrix.empty} hint={l.matrix.emptyHint} />
      ) : matrix.visible.length === 0 ? (
        <LibraryPageState
          variant="empty"
          title={l.matrix.emptyFiltered}
          onRetry={matrix.clearFilters}
        />
      ) : null}

      {wizardKeys && wizardKeys.length > 0 && (
        <PropagationWizard
          resourceKeys={wizardKeys}
          locationIds={candidateLocationIds}
          onClose={() => {
            setWizardKeys(null);
            matrix.clearSelection();
          }}
        />
      )}
    </div>
  );
}
