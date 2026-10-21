/**
 * One resource, in full: its distinct versions first, then who reads which.
 *
 * Content before coverage is deliberate. With no canonical copy the first
 * question is "what are my options?", and the replication count sitting next to
 * the modification time is what makes the common trap visible — the newest
 * version is frequently the one held in only one place.
 */

import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import type {
  LibraryCoverage,
  LibraryResource,
  PropagationSourceGroup,
} from '@mangostudio/shared/library';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { StatusDot, type StatusDotTone } from '@/components/ui/StatusDot';
import { EnvironmentScopeHeader } from '@/features/environments/components/EnvironmentScopeHeader';
import { EnvironmentScopeNotice } from '@/features/environments/components/EnvironmentScopeNotice';
import { useEnvironmentScope } from '@/features/environments/use-environment-scope';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage, formatRelativeTime } from '@/lib/i18n-format';
import { ICON_SM } from '@/lib/icon-sizes';
import { formatBytes, hashPrefix, validInstances } from '../format';
import { useCandidateLocations } from '../hooks/use-candidate-locations';
import {
  libraryEnvironmentSearch,
  libraryKeys,
  libraryLocationsQueryOptions,
  libraryResourceQueryOptions,
  libraryTargetsQueryOptions,
} from '../queries';
import { ContentGroupList } from './ContentGroupList';
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

const COVERAGE_DOT: Readonly<Record<LibraryCoverage['state'], StatusDotTone>> = {
  present: 'success',
  absent: 'neutral',
  shadowed: 'neutral',
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
  const { t, locale } = useI18n();
  const l = t.library;
  const scope = useEnvironmentScope();
  const isLocal = scope.environmentId === LOCAL_ENVIRONMENT_ID;
  const queryClient = useQueryClient();
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

  // No description: the library section layout already renders the subtitle
  // directly above the tab strip this page sits under.
  const header = (
    <EnvironmentScopeHeader
      scope={scope}
      onRefresh={() => {
        void resourceQuery.refetch();
        void locationsQuery.refetch();
        void queryClient.invalidateQueries({
          queryKey: libraryKeys.contents(resourceKey, scope.environmentId),
        });
      }}
    />
  );

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

  if (resourceQuery.isPending) {
    return (
      <div className="space-y-4">
        {header}
        <LibraryPageState variant="loading" />
      </div>
    );
  }
  if (resourceQuery.error || !resource) {
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
          <LibraryPageState
            variant="error"
            title={l.detail.notFound}
            onRetry={() => void resourceQuery.refetch()}
          />
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

  const invalid = resource.instances.filter((instance) => !instance.valid);

  return (
    <div className="space-y-6" data-testid="resource-detail" data-resource-key={resource.key}>
      {header}
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <Link
            to={kindTab(resource)}
            search={libraryEnvironmentSearch(scope.environmentId)}
            className="inline-flex items-center gap-1.5 text-fg-muted text-xs hover:text-fg"
          >
            <ArrowLeft size={ICON_SM} aria-hidden="true" />
            {l.detail.back}
          </Link>
          <h2 className="font-semibold text-fg text-title">{resource.key}</h2>
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
        <h3 className="font-semibold text-base text-fg">{l.detail.contentHeading}</h3>
        {groups.length === 0 ? (
          <p className="text-fg-muted text-sm">{l.detail.notFound}</p>
        ) : (
          <ContentGroupList
            groups={groups}
            locationLabel={locationLabel}
            renderMeta={(group) =>
              [
                formatMessage(l.detail.copies, { count: String(group.instanceCount) }),
                formatMessage(l.detail.modified, {
                  when: formatRelativeTime(group.newestModifiedAtMs, locale),
                }),
                formatBytes(group.sizeBytes),
              ].join(' · ')
            }
          />
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
        <h3 className="font-semibold text-base text-fg">{l.detail.coverageHeading}</h3>
        <ul className="space-y-2">
          {resource.coverage.map((coverage) => (
            <li
              key={coverage.targetId}
              className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-sm"
              data-testid="coverage-row"
              data-target-id={coverage.targetId}
              data-state={coverage.state}
            >
              <span className="w-28 shrink-0 font-medium text-fg">
                {l.targets[coverage.targetId]}
              </span>
              <span className="inline-flex items-center gap-2 text-fg-muted">
                <StatusDot tone={COVERAGE_DOT[coverage.state]} className="self-center" />
                {l.coverage[coverage.state]}
              </span>
              {coverage.effectiveLocationId && (
                <span className="text-fg-muted text-xs">
                  {formatMessage(l.detail.via, {
                    location: locationLabel(coverage.effectiveLocationId),
                  })}
                </span>
              )}
              {/*
                A location is only reported as a shadow here — the matrix keeps
                that as an implementation detail until someone asks, and this is
                where they asked.
              */}
              {coverage.shadowedLocationIds.length > 0 && (
                <span className="text-fg-muted text-xs">
                  {formatMessage(l.detail.alsoIn, {
                    locations: coverage.shadowedLocationIds.map(locationLabel).join(', '),
                  })}
                </span>
              )}
            </li>
          ))}
        </ul>
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

/** Which tab this resource lives under, for the back link. */
function kindTab(resource: LibraryResource) {
  // Exhaustive on purpose: a `default` here sends a kind nobody wired up to the
  // skills tab, which looks like a working back link and is not one.
  switch (resource.ref.kind) {
    case 'skill':
      return '/environments/library/skills' as const;
    case 'subagent':
      return '/environments/library/subagents' as const;
    case 'command':
      return '/environments/library/commands' as const;
    case 'instruction':
      return '/environments/library/instructions' as const;
    case 'setting':
    case 'hook':
      return '/environments/library/settings' as const;
  }
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
