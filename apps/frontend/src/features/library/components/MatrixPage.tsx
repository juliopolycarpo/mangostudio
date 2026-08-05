/**
 * One kind tab: filters, the matrix, and the bulk action that turns a row
 * selection into a single propagation review.
 *
 * Six skills going to Cursor is one review, not six — the selection is the unit
 * of work, and the wizard opens once for the whole set.
 */

import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import type { ResourceKind } from '@mangostudio/shared/library';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { EnvironmentScopeHeader } from '@/features/environments/components/EnvironmentScopeHeader';
import { EnvironmentScopeNotice } from '@/features/environments/components/EnvironmentScopeNotice';
import { useEnvironmentScope } from '@/features/environments/use-environment-scope';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { useCandidateLocations } from '../hooks/use-candidate-locations';
import { useLibraryMatrix } from '../hooks/use-library-matrix';
import { CoverageMatrix, MatrixLegend } from './CoverageMatrix';
import { LibraryPageState } from './LibraryPageState';
import { MatrixFilters } from './MatrixFilters';
import { PropagationWizard } from './PropagationWizard';

export function MatrixPage({ kind }: { readonly kind: ResourceKind }) {
  const { t } = useI18n();
  const l = t.library;
  const scope = useEnvironmentScope();
  const isLocal = scope.environmentId === LOCAL_ENVIRONMENT_ID;
  const matrix = useLibraryMatrix(kind, scope.environmentId);
  const [wizardKeys, setWizardKeys] = useState<readonly string[] | null>(null);

  useEffect(() => {
    setWizardKeys(null);
  }, [scope.environmentId]);

  /**
   * Every enabled location storing this kind is previewed, not only the ones
   * the user might pick: the destination step needs the full list to say what a
   * location is blocked by, and a location absent from the preview cannot be
   * explained at all. Disabled locations are excluded — the API refuses them.
   */
  const candidates = useCandidateLocations(matrix.locations, kind);

  // No description: the library section layout already renders the subtitle
  // directly above the tab strip this page sits under.
  const header = <EnvironmentScopeHeader scope={scope} onRefresh={matrix.refetch} />;

  if (scope.environment && !scope.permitsLibrary) {
    return (
      <div className="space-y-4">
        {header}
        <EnvironmentScopeNotice
          environment={scope.environment}
          reason="not-permitted"
          surface="library"
        />
      </div>
    );
  }

  if (matrix.isPending && matrix.resources.length === 0) {
    return (
      <div className="space-y-4">
        {header}
        <LibraryPageState variant="loading" />
      </div>
    );
  }

  if (matrix.error && matrix.resources.length === 0) {
    return (
      <div className="space-y-4">
        {header}
        {scope.environment && !scope.isConnected ? (
          <EnvironmentScopeNotice
            environment={scope.environment}
            reason="disconnected"
            surface="library"
          />
        ) : (
          <LibraryPageState variant="error" onRetry={matrix.refetch} />
        )}
      </div>
    );
  }

  if (!isLocal && scope.environment && !scope.isConnected) {
    return (
      <div className="space-y-4">
        {header}
        <EnvironmentScopeNotice
          environment={scope.environment}
          reason="disconnected"
          surface="library"
        />
      </div>
    );
  }

  const selectedCount = matrix.selected.size;

  return (
    <div className="space-y-4">
      {header}

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
              <Button
                size="sm"
                onClick={() => setWizardKeys([...matrix.selected])}
                disabled={!candidates.isResolved}
              >
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
        environmentId={scope.environmentId}
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
          locationIds={candidates.locationIds}
          environmentId={scope.environmentId}
          onClose={() => {
            setWizardKeys(null);
            matrix.clearSelection();
          }}
        />
      )}
    </div>
  );
}
