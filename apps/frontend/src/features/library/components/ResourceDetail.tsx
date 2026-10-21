/**
 * One resource, in full: its distinct versions first, then who reads which.
 *
 * Content before coverage is deliberate. With no canonical copy the first
 * question is "what are my options?", and the replication count sitting next to
 * the modification time is what makes the common trap visible — the newest
 * version is frequently the one held in only one place.
 */

import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import type { LibraryResource, PropagationSourceGroup } from '@mangostudio/shared/library';
import { useQueries } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { MicroLabel } from '@/components/ui/MicroLabel';
import { EnvironmentScopeNotice } from '@/features/environments/components/EnvironmentScopeNotice';
import { useEnvironmentScope } from '@/features/environments/use-environment-scope';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { ICON_SM } from '@/lib/icon-sizes';
import { hashPrefix, libraryKindPath, validInstances } from '../format';
import { useCandidateLocations } from '../hooks/use-candidate-locations';
import {
  libraryEnvironmentSearch,
  libraryLocationsQueryOptions,
  libraryResourceQueryOptions,
  libraryTargetsQueryOptions,
} from '../queries';
import { ContentGroupList } from './ContentGroupList';
import { CoverageList } from './CoverageList';
import { InlineNote } from './InlineNote';
import { InstanceDiff } from './InstanceDiff';
import { LibraryPageState } from './LibraryPageState';
import { PropagationWizard } from './PropagationWizard';
import { RemovalWizard } from './RemovalWizard';

/** Copies that differ, or cannot be compared, are the ones worth a second look. */
const DIVERGENCE_BADGE: Readonly<
  Record<LibraryResource['divergence'], 'neutral' | 'success' | 'warning'>
> = {
  single: 'neutral',
  uniform: 'success',
  divergent: 'warning',
  'not-comparable': 'neutral',
  incomparable: 'warning',
};

export function ResourceDetail({
  resourceKey,
  initialCompare = false,
}: {
  readonly resourceKey: string;
  /**
   * Opens the version comparison on arrival, for links that mean "show me what
   * differs" — the workspace hub's divergence card is the first of them.
   */
  readonly initialCompare?: boolean;
}) {
  const { t } = useI18n();
  const l = t.library;
  const scope = useEnvironmentScope();
  const isLocal = scope.environmentId === LOCAL_ENVIRONMENT_ID;
  const [comparing, setComparing] = useState(initialCompare);
  const [propagating, setPropagating] = useState(false);
  const [removing, setRemoving] = useState(false);

  // Every one of these is about the machine that was selected when it opened.
  // Without this, switching away only hides them, and switching back re-opens a
  // wizard over a different environment's instances.
  useEffect(() => {
    setComparing(false);
    setPropagating(false);
    setRemoving(false);
  }, [scope.environmentId]);

  const [resourceQuery, locationsQuery, targetsQuery] = useQueries({
    queries: [
      libraryResourceQueryOptions(resourceKey, scope.environmentId),
      libraryLocationsQueryOptions(scope.environmentId),
      libraryTargetsQueryOptions(),
    ],
  });

  const resource = resourceQuery.data;
  const locations = useMemo(() => locationsQuery.data ?? [], [locationsQuery.data]);
  const locationLabel = useMemo(
    () => (locationId: string) =>
      locations.find((candidate) => candidate.id === locationId)?.path ?? locationId,
    [locations]
  );

  const groups = useMemo(
    () => (resource ? contentGroupsOf(resource, scope.environmentId) : []),
    [resource, scope.environmentId]
  );
  const candidates = useCandidateLocations(locations, resource?.ref.kind);

  if (scope.environment && !scope.permitsLibrary) {
    return (
      <EnvironmentScopeNotice
        environment={scope.environment}
        reason="not-permitted"
        surface="library"
      />
    );
  }

  if (resourceQuery.isPending) return <LibraryPageState variant="loading" />;
  if (resourceQuery.error || !resource) {
    return scope.environment && !scope.isConnected ? (
      <EnvironmentScopeNotice
        environment={scope.environment}
        reason="disconnected"
        surface="library"
      />
    ) : (
      <LibraryPageState
        variant="error"
        title={l.detail.notFound}
        onRetry={() => void resourceQuery.refetch()}
      />
    );
  }

  if (!isLocal && scope.environment && !scope.isConnected) {
    return (
      <EnvironmentScopeNotice
        environment={scope.environment}
        reason="disconnected"
        surface="library"
      />
    );
  }

  const invalid = resource.instances.filter((instance) => !instance.valid);

  return (
    <div className="space-y-6" data-testid="resource-detail" data-resource-key={resource.key}>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <Link
            to={libraryKindPath(resource.ref.kind)}
            search={libraryEnvironmentSearch(scope.environmentId)}
            className="inline-flex items-center gap-1.5 text-fg-muted text-xs hover:text-fg"
          >
            <ArrowLeft size={ICON_SM} aria-hidden="true" />
            {l.detail.back}
          </Link>
          {/* The name, not the `kind:name` id: the kind is stated once, on the
              line below, and a second page-level heading under the umbrella's
              would outrank the page it sits in. It is a `text-base` section title;
              the groups under it are micro-labels, as in the Backups page, so the
              name is always the largest thing below the page's own title. */}
          <h2 className="font-semibold text-base text-fg">{resource.ref.slug}</h2>
          <p className="flex flex-wrap items-center gap-2 text-fg-muted text-sm">
            {l.kinds[resource.ref.kind]}
            <Badge variant={DIVERGENCE_BADGE[resource.divergence]}>
              {l.divergence[resource.divergence]}
            </Badge>
          </p>
        </div>
        <div className="flex items-center gap-2">
          {candidates.isDetecting && (
            <span className="text-fg-muted text-xs" data-testid="detecting-agents">
              {l.locationSettings.detecting}
            </span>
          )}
          <Button
            variant="secondary"
            onClick={() => setRemoving(true)}
            disabled={!candidates.isResolved}
            data-testid="remove-resource"
          >
            {l.detail.remove}
          </Button>
          <Button onClick={() => setPropagating(true)} disabled={!candidates.isResolved}>
            {l.detail.propagate}
          </Button>
        </div>
      </header>

      {resource.divergence === 'not-comparable' && (
        <Callout tone="neutral" data-testid="not-comparable">
          {l.detail.notComparable}
        </Callout>
      )}
      {resource.divergence === 'incomparable' && (
        <Callout tone="warning" data-testid="incomparable">
          {l.detail.incomparable}
        </Callout>
      )}

      <section className="space-y-3">
        <MicroLabel as="h3">{l.detail.contentHeading}</MicroLabel>
        {groups.length === 0 ? (
          <p className="text-fg-muted text-sm">{l.detail.notFound}</p>
        ) : (
          <ContentGroupList groups={groups} locationLabel={locationLabel} />
        )}

        {groups.length >= 2 && resource.divergence !== 'incomparable' && (
          <div className="space-y-3">
            <Button variant="secondary" size="sm" onClick={() => setComparing((open) => !open)}>
              {comparing
                ? l.detail.compareHide
                : formatMessage(l.detail.compare, {
                    left: `${hashPrefix(groups[0].contentHash)}…`,
                    right: `${hashPrefix(groups[1].contentHash)}…`,
                  })}
            </Button>
            {comparing && (
              <InstanceDiff
                resourceKey={resource.key}
                kind={resource.ref.kind}
                left={{
                  locationId: groups[0].contentLocationId,
                  contentHash: groups[0].contentHash,
                }}
                right={{
                  locationId: groups[1].contentLocationId,
                  contentHash: groups[1].contentHash,
                }}
                whitespaceOnly={resource.whitespaceOnlyDivergence}
                environmentId={scope.environmentId}
              />
            )}
            {groups.length > 2 && <p className="text-fg-muted text-xs">{l.detail.compareSelect}</p>}
          </div>
        )}
      </section>

      {invalid.length > 0 && (
        <Callout tone="danger" data-testid="invalid-instances">
          <ul className="space-y-1">
            {invalid.map((instance) => (
              <li key={instance.locationId}>
                {formatMessage(l.detail.invalidInstance, {
                  location: locationLabel(instance.locationId),
                })}
                {instance.valid === false && ` — ${l.invalidReason[instance.invalidReason]}`}
              </li>
            ))}
          </ul>
        </Callout>
      )}

      <section className="space-y-3">
        <MicroLabel as="h3">{l.detail.coverageHeading}</MicroLabel>
        <CoverageList coverage={resource.coverage} locationLabel={locationLabel} />
        {targetsQuery.isError && <InlineNote tone="danger">{l.matrix.loadError}</InlineNote>}
      </section>

      {propagating && (
        <PropagationWizard
          resourceKeys={[resource.key]}
          locationIds={candidates.locationIds}
          environmentId={scope.environmentId}
          onClose={() => setPropagating(false)}
        />
      )}

      {removing && (
        <RemovalWizard
          resourceKeys={[resource.key]}
          locationIds={candidates.locationIds}
          environmentId={scope.environmentId}
          onClose={() => setRemoving(false)}
        />
      )}
    </div>
  );
}

/**
 * Rebuilds the propagation source-group shape from a plain resource, so the
 * detail view and the wizard render versions through one component. Only
 * readable copies join a group: an unreadable one has no content to compare and
 * is reported separately.
 */
function contentGroupsOf(
  resource: LibraryResource,
  environmentId: string
): PropagationSourceGroup[] {
  const instances = validInstances(resource);
  return resource.contentGroups.flatMap((group) => {
    const members = instances.filter((instance) => instance.contentHash === group.contentHash);
    if (members.length === 0) return [];
    const locationIds = members.map((instance) => instance.locationId).sort();
    return [
      {
        contentHash: group.contentHash,
        locationIds,
        instanceCount: members.length,
        formats: [...new Set(members.map((instance) => instance.format))].sort(),
        newestModifiedAtMs: Math.max(...members.map((instance) => instance.modifiedAtMs)),
        sizeBytes: members[0].sizeBytes,
        contentLocationId: locationIds[0],
        // The detail view describes one machine, so every group on it is that
        // machine's. The wizard is where copies from several machines meet.
        environmentIds: [environmentId],
        contentEnvironmentId: environmentId,
        contentPath: members[0].path,
      },
    ];
  });
}
