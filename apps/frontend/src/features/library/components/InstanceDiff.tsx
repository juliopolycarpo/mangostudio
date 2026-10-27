/**
 * Compares two versions of a resource.
 *
 * Renders through the chat surface's diff body rather than a second diff
 * component: the codebase already has settled conventions for how an added
 * line, a removed line, and a truncated diff look, and two diff renderers would
 * mean two sets of them.
 *
 * A skill is a directory, and the content route serves its `SKILL.md`, so this
 * compares entrypoints. That is said out loud — a directory diffed as one blob
 * is unreadable, and silently comparing one file out of many would be worse.
 */

import type { LibraryLocationId, ResourceKind } from '@mangostudio/shared/library';
import { useQueries } from '@tanstack/react-query';
import { useMemo } from 'react';

import { Callout } from '@/components/ui/Callout';
import { diffTextLines } from '@/features/chat/components/file-change-preview';
import { FileChangePreviewBody } from '@/features/chat/components/FileChangePreview';
import { useI18n } from '@/hooks/use-i18n';

import { hashPrefix } from '../format';
import { libraryContentQueryOptions } from '../queries';
import { LibraryPageState } from './LibraryPageState';

interface DiffSide {
  readonly locationId: LibraryLocationId;
  readonly contentHash: string;
  /**
   * Machine this copy is on. Falls back to the surrounding scope — the two
   * sides of a within-machine comparison are both on it — but a cross-machine
   * diff has to name each side, or one of them is read from a same-named file
   * on the wrong host.
   */
  readonly environmentId?: string;
}

interface InstanceDiffProps {
  readonly resourceKey: string;
  readonly kind: ResourceKind;
  readonly left: DiffSide;
  readonly right: DiffSide;
  /** True when the two versions differ only in whitespace, per the scanner. */
  readonly whitespaceOnly: boolean;
  readonly environmentId?: string;
}

export function InstanceDiff({
  resourceKey,
  kind,
  left,
  right,
  whitespaceOnly,
  environmentId,
}: InstanceDiffProps) {
  const { t } = useI18n();
  const l = t.library;

  const [leftQuery, rightQuery] = useQueries({
    queries: [
      libraryContentQueryOptions(resourceKey, left.locationId, left.environmentId ?? environmentId),
      libraryContentQueryOptions(
        resourceKey,
        right.locationId,
        right.environmentId ?? environmentId
      ),
    ],
  });

  const preview = useMemo(() => {
    if (!leftQuery.data || !rightQuery.data) return null;
    const lines = diffTextLines(leftQuery.data.content, rightQuery.data.content);
    return {
      files: [
        {
          op: 'update' as const,
          path: `${hashPrefix(left.contentHash)}… → ${hashPrefix(right.contentHash)}…`,
          lines,
          added: lines.filter((line) => line.kind === 'add').length,
          removed: lines.filter((line) => line.kind === 'del').length,
        },
      ],
    };
  }, [leftQuery.data, rightQuery.data, left.contentHash, right.contentHash]);

  if (leftQuery.isPending || rightQuery.isPending) {
    return <LibraryPageState variant="loading" />;
  }
  if (leftQuery.error || rightQuery.error || !preview) {
    return <LibraryPageState variant="error" title={l.diff.error} />;
  }

  const truncated = Boolean(leftQuery.data?.truncated || rightQuery.data?.truncated);
  const noVisibleDifference = preview.files[0].lines.length === 0;

  return (
    <div className="space-y-3 text-xs" data-testid="instance-diff">
      {/*
        001 deliberately does not normalize line endings, so a CRLF/LF split is a
        real divergence that a line diff renders as nothing at all. Without this
        banner that is simply baffling.
      */}
      {whitespaceOnly && (
        <Callout
          tone="info"
          title={l.detail.whitespaceOnlyTitle}
          data-testid="whitespace-only-banner"
        >
          {l.detail.whitespaceOnlyDescription}
        </Callout>
      )}
      {kind === 'skill' && (
        <p className="text-fg-muted" data-testid="entrypoint-only-note">
          {l.detail.entrypointOnly}
        </p>
      )}
      {truncated && <Callout tone="info" title={l.diff.truncated} />}
      {noVisibleDifference ? (
        <p className="text-fg-muted" data-testid="diff-identical">
          {kind === 'skill' ? l.detail.identicalEntrypoint : l.diff.identical}
        </p>
      ) : (
        <FileChangePreviewBody preview={preview} />
      )}
    </div>
  );
}
