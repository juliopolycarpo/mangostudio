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
import { FileChangePreviewBody } from '@/features/chat/components/FileChangePreview';
import { diffTextLines } from '@/features/chat/components/file-change-preview';
import { useI18n } from '@/hooks/use-i18n';
import { hashPrefix } from '../format';
import { libraryContentQueryOptions } from '../queries';
import { LibraryPageState } from './LibraryPageState';

interface InstanceDiffProps {
  readonly resourceKey: string;
  readonly kind: ResourceKind;
  readonly left: { readonly locationId: LibraryLocationId; readonly contentHash: string };
  readonly right: { readonly locationId: LibraryLocationId; readonly contentHash: string };
  /** True when the two versions differ only in whitespace, per the scanner. */
  readonly whitespaceOnly: boolean;
}

export function InstanceDiff({
  resourceKey,
  kind,
  left,
  right,
  whitespaceOnly,
}: InstanceDiffProps) {
  const { t } = useI18n();
  const l = t.library;

  const [leftQuery, rightQuery] = useQueries({
    queries: [
      libraryContentQueryOptions(resourceKey, left.locationId),
      libraryContentQueryOptions(resourceKey, right.locationId),
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
    <div className="space-y-2 text-[11px]" data-testid="instance-diff">
      {/*
        001 deliberately does not normalize line endings, so a CRLF/LF split is a
        real divergence that a line diff renders as nothing at all. Without this
        banner that is simply baffling.
      */}
      {whitespaceOnly && (
        <Banner tone="warn" testId="whitespace-only-banner" title={l.detail.whitespaceOnlyTitle}>
          {l.detail.whitespaceOnlyDescription}
        </Banner>
      )}
      {kind === 'skill' && (
        <p className="text-on-surface-variant/60" data-testid="entrypoint-only-note">
          {l.detail.entrypointOnly}
        </p>
      )}
      {truncated && <p className="text-tertiary">{l.diff.truncated}</p>}
      {noVisibleDifference ? (
        <p className="text-on-surface-variant" data-testid="diff-identical">
          {kind === 'skill' ? l.detail.identicalEntrypoint : l.diff.identical}
        </p>
      ) : (
        <FileChangePreviewBody preview={preview} />
      )}
    </div>
  );
}

function Banner({
  tone,
  title,
  testId,
  children,
}: {
  readonly tone: 'warn' | 'info';
  readonly title: string;
  readonly testId?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div
      data-testid={testId}
      className={`rounded-lg border p-2.5 ${
        tone === 'warn'
          ? 'border-tertiary/25 bg-tertiary/5 text-on-surface'
          : 'border-outline-variant/20 bg-surface-container/60 text-on-surface-variant'
      }`}
    >
      <p className="font-semibold text-[11px]">{title}</p>
      <p className="mt-0.5 text-[11px] text-on-surface-variant/80">{children}</p>
    </div>
  );
}
