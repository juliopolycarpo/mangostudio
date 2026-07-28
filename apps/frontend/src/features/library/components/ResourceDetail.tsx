/**
 * One resource, in full: its distinct versions first, then who reads which.
 *
 * Content before coverage is deliberate. With no canonical copy the first
 * question is "what are my options?", and the replication count sitting next to
 * the modification time is what makes the common trap visible — the newest
 * version is frequently the one held in only one place.
 */

import type { LibraryResource, PropagationSourceGroup } from '@mangostudio/shared/library';
import { useQueries } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { formatBytes, formatRelativeTime, hashPrefix, validInstances } from '../format';
import { useCandidateLocationIds } from '../hooks/use-candidate-locations';
import {
  libraryLocationsQueryOptions,
  libraryResourceQueryOptions,
  libraryTargetsQueryOptions,
} from '../queries';
import { ContentGroupList } from './ContentGroupList';
import { InstanceDiff } from './InstanceDiff';
import { LibraryPageState } from './LibraryPageState';
import { PropagationWizard } from './PropagationWizard';

export function ResourceDetail({ resourceKey }: { readonly resourceKey: string }) {
  const { t, locale } = useI18n();
  const l = t.library;
  const [comparing, setComparing] = useState(false);
  const [propagating, setPropagating] = useState(false);

  const [resourceQuery, locationsQuery, targetsQuery] = useQueries({
    queries: [
      libraryResourceQueryOptions(resourceKey),
      libraryLocationsQueryOptions(),
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

  const groups = useMemo(() => (resource ? contentGroupsOf(resource) : []), [resource]);
  const candidateLocationIds = useCandidateLocationIds(locations, resource?.ref.kind);

  if (resourceQuery.isPending) return <LibraryPageState variant="loading" />;
  if (resourceQuery.error || !resource) {
    return (
      <LibraryPageState
        variant="error"
        title={l.detail.notFound}
        onRetry={() => void resourceQuery.refetch()}
      />
    );
  }

  const invalid = resource.instances.filter((instance) => !instance.valid);

  return (
    <div className="space-y-5" data-testid="resource-detail" data-resource-key={resource.key}>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <Link
            to={kindTab(resource)}
            className="inline-flex items-center gap-1.5 text-on-surface-variant text-xs hover:text-on-surface"
          >
            <ArrowLeft size={12} />
            {l.detail.back}
          </Link>
          <h2 className="font-bold text-lg text-on-surface">{resource.key}</h2>
          <p className="text-on-surface-variant/60 text-xs">
            {`${l.kinds[resource.ref.kind]} · ${l.divergence[resource.divergence]}`}
          </p>
        </div>
        {candidateLocationIds.length > 0 && (
          <Button size="sm" onClick={() => setPropagating(true)}>
            {l.detail.propagate}
          </Button>
        )}
      </header>

      {resource.divergence === 'not-comparable' && (
        <p className="text-on-surface-variant text-xs" data-testid="not-comparable">
          {l.detail.notComparable}
        </p>
      )}

      <section className="space-y-2">
        <h3 className="font-label font-semibold text-[10px] text-on-surface-variant/70 uppercase tracking-widest">
          {l.detail.contentHeading}
        </h3>
        {groups.length === 0 ? (
          <p className="text-on-surface-variant text-xs">{l.detail.notFound}</p>
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

        {groups.length >= 2 && (
          <div className="space-y-2">
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
              />
            )}
            {groups.length > 2 && (
              <p className="text-[11px] text-on-surface-variant/60">{l.detail.compareSelect}</p>
            )}
          </div>
        )}
      </section>

      {invalid.length > 0 && (
        <ul className="space-y-1" data-testid="invalid-instances">
          {invalid.map((instance) => (
            <li key={instance.locationId} className="text-[11px] text-error">
              {formatMessage(l.detail.invalidInstance, {
                location: locationLabel(instance.locationId),
              })}
              {instance.valid === false && ` — ${l.invalidReason[instance.invalidReason]}`}
            </li>
          ))}
        </ul>
      )}

      <section className="space-y-2">
        <h3 className="font-label font-semibold text-[10px] text-on-surface-variant/70 uppercase tracking-widest">
          {l.detail.coverageHeading}
        </h3>
        <ul className="space-y-1.5">
          {resource.coverage.map((coverage) => (
            <li
              key={coverage.targetId}
              className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs"
              data-testid="coverage-row"
              data-target-id={coverage.targetId}
              data-state={coverage.state}
            >
              <span className="w-28 shrink-0 font-medium text-on-surface">
                {l.targets[coverage.targetId]}
              </span>
              <span className="text-on-surface-variant">{l.coverage[coverage.state]}</span>
              {coverage.effectiveLocationId && (
                <span className="text-on-surface-variant/60">
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
                <span className="text-on-surface-variant/60">
                  {formatMessage(l.detail.alsoIn, {
                    locations: coverage.shadowedLocationIds.map(locationLabel).join(', '),
                  })}
                </span>
              )}
            </li>
          ))}
        </ul>
        {targetsQuery.isError && <p className="text-[11px] text-error">{l.matrix.loadError}</p>}
      </section>

      {propagating && (
        <PropagationWizard
          resourceKeys={[resource.key]}
          locationIds={candidateLocationIds}
          onClose={() => setPropagating(false)}
        />
      )}
    </div>
  );
}

/** Which tab this resource lives under, for the back link. */
function kindTab(resource: LibraryResource) {
  switch (resource.ref.kind) {
    case 'subagent':
      return '/library/subagents' as const;
    case 'instruction':
      return '/library/instructions' as const;
    case 'setting':
    case 'hook':
      return '/library/settings' as const;
    default:
      return '/library/skills' as const;
  }
}

/**
 * Rebuilds the propagation source-group shape from a plain resource, so the
 * detail view and the wizard render versions through one component. Only
 * readable copies join a group: an unreadable one has no content to compare and
 * is reported separately.
 */
function contentGroupsOf(resource: LibraryResource): PropagationSourceGroup[] {
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
        contentPath: members[0].path,
      },
    ];
  });
}
