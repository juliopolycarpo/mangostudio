/** Conflict-aware MCP portability import with explicit per-entry decisions. */

import type {
  McpPortabilityApplyResponse,
  McpPortabilityDecision,
  McpPortabilityPreviewEntry,
  PreviewMcpPortabilityImportBody,
} from '@mangostudio/shared/mcp';
import { useState } from 'react';

import { SettingsField } from '@/components/settings/SettingsField';
import { SettingsSegmented } from '@/components/settings/SettingsSegmented';
import { StatusNote } from '@/components/settings/StatusNote';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Dialog } from '@/components/ui/Dialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { FIELD_CLASS, Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { useI18n } from '@/hooks/use-i18n';
import { cn, resolveApiErrorMessage } from '@/lib/utils';

import { useApplyPortableMcpImport, usePreviewPortableMcpImport } from '../hooks/use-mcp-servers';

interface ImportServersDialogProps {
  onClose: () => void;
}

type SourceKind = 'file' | 'path' | 'json';

interface DecisionState {
  decision: McpPortabilityDecision;
  targetServerId?: string;
  secretEnv: Record<string, string>;
  headers: Record<string, string>;
}

type Step =
  | { kind: 'source' }
  | {
      kind: 'preview';
      previewToken: string;
      entries: McpPortabilityPreviewEntry[];
      decisions: Record<string, DecisionState>;
    }
  | { kind: 'summary'; summary: McpPortabilityApplyResponse };

export function ImportServersDialog({ onClose }: ImportServersDialogProps) {
  const { t } = useI18n();
  const s = t.settings.mcp;
  const [sourceKind, setSourceKind] = useState<SourceKind>('file');
  const [path, setPath] = useState('');
  const [json, setJson] = useState('');
  const [fileName, setFileName] = useState('');
  const [step, setStep] = useState<Step>({ kind: 'source' });
  const [submitError, setSubmitError] = useState<string | null>(null);
  const previewMutation = usePreviewPortableMcpImport();
  const applyMutation = useApplyPortableMcpImport();

  const sourceBody = (): PreviewMcpPortabilityImportBody | null => {
    const value = (sourceKind === 'path' ? path : json).trim();
    if (value.length === 0) return null;
    return sourceKind === 'path' ? { path: value } : { json: value };
  };

  const handlePreview = () => {
    const body = sourceBody();
    if (!body) {
      setSubmitError(s.import.sourceRequired);
      return;
    }
    setSubmitError(null);
    previewMutation.mutate(body, {
      onSuccess: ({ entries, previewToken }) => {
        // The preview only ever suggests `add` or `skip`, so no entry starts
        // out needing a replacement target; `setDecision` picks one if the
        // reviewer switches to `replace`.
        const decisions = Object.fromEntries(
          entries.map((entry) => [
            entry.key,
            {
              decision: entry.suggestedDecision,
              secretEnv: {},
              headers: {},
            } satisfies DecisionState,
          ])
        );
        setStep({ kind: 'preview', entries, previewToken, decisions });
      },
      onError: (error) =>
        setSubmitError(resolveApiErrorMessage(error, s.portability.previewFailed)),
    });
  };

  const patchDecision = (key: string, patch: Partial<DecisionState>) => {
    if (step.kind !== 'preview') return;
    const current = step.decisions[key];
    if (!current) return;
    setStep({
      ...step,
      decisions: { ...step.decisions, [key]: { ...current, ...patch } },
    });
  };

  const setDecision = (entry: McpPortabilityPreviewEntry, decision: McpPortabilityDecision) => {
    patchDecision(entry.key, {
      decision,
      targetServerId:
        decision === 'replace'
          ? entry.conflicts.find((candidate) => !candidate.replaceBlockedBySlug)?.serverId
          : undefined,
    });
  };

  const setSecretValue = (
    entryKey: string,
    kind: 'env' | 'header',
    name: string,
    value: string
  ) => {
    if (step.kind !== 'preview') return;
    const current = step.decisions[entryKey];
    if (!current) return;
    const field = kind === 'env' ? 'secretEnv' : 'headers';
    patchDecision(entryKey, { [field]: { ...current[field], [name]: value } });
  };

  const handleApply = () => {
    const body = sourceBody();
    if (step.kind !== 'preview' || !body) return;
    setSubmitError(null);
    applyMutation.mutate(
      {
        ...body,
        previewToken: step.previewToken,
        decisions: step.entries.flatMap((entry) => {
          const state = step.decisions[entry.key];
          if (!state) return [];
          return [
            {
              key: entry.key,
              decision: state.decision,
              ...(state.targetServerId !== undefined && { targetServerId: state.targetServerId }),
              ...(Object.keys(state.secretEnv).length > 0 && { secretEnv: state.secretEnv }),
              ...(Object.keys(state.headers).length > 0 && { headers: state.headers }),
            },
          ];
        }),
      },
      {
        onSuccess: (summary) => setStep({ kind: 'summary', summary }),
        onError: (error) =>
          setSubmitError(resolveApiErrorMessage(error, s.portability.applyFailed)),
      }
    );
  };

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    setFileName(file.name);
    setJson(await file.text());
    setSubmitError(null);
  };

  const busy = previewMutation.isPending || applyMutation.isPending;

  return (
    <Dialog
      title={s.import.title}
      description={s.portability.importDescription}
      closeDisabled={busy}
      onClose={onClose}
      notice={submitError ? <Callout tone="danger">{submitError}</Callout> : undefined}
      footer={
        <>
          {step.kind === 'source' && (
            <>
              <Button variant="secondary" onClick={onClose}>
                {s.cancelButton}
              </Button>
              <Button loading={previewMutation.isPending} onClick={handlePreview}>
                {previewMutation.isPending ? s.import.previewingButton : s.import.previewButton}
              </Button>
            </>
          )}
          {step.kind === 'preview' && (
            <>
              <Button
                variant="secondary"
                onClick={() => {
                  setSubmitError(null);
                  setStep({ kind: 'source' });
                }}
              >
                {s.import.backButton}
              </Button>
              <Button
                disabled={!canApplyPreview(step)}
                loading={applyMutation.isPending}
                onClick={handleApply}
              >
                {applyMutation.isPending ? s.portability.applying : s.portability.applyButton}
              </Button>
            </>
          )}
          {step.kind === 'summary' && <Button onClick={onClose}>{s.portability.done}</Button>}
        </>
      }
    >
      {step.kind === 'source' && (
        <SourceStep
          sourceKind={sourceKind}
          path={path}
          json={json}
          fileName={fileName}
          onSourceKind={setSourceKind}
          onPath={setPath}
          onJson={setJson}
          onFile={handleFile}
        />
      )}
      {step.kind === 'preview' && (
        <PreviewStep
          entries={step.entries}
          decisions={step.decisions}
          onDecision={setDecision}
          onReplaceTarget={(entryKey, targetServerId) =>
            patchDecision(entryKey, { targetServerId })
          }
          onSecretValue={setSecretValue}
        />
      )}
      {step.kind === 'summary' && <SummaryStep summary={step.summary} />}
    </Dialog>
  );
}

interface SourceStepProps {
  sourceKind: SourceKind;
  path: string;
  json: string;
  fileName: string;
  onSourceKind: (kind: SourceKind) => void;
  onPath: (value: string) => void;
  onJson: (value: string) => void;
  onFile: (file: File | undefined) => void;
}

function SourceStep(props: SourceStepProps) {
  const { t } = useI18n();
  const s = t.settings.mcp;
  const sourceOptions: { value: SourceKind; label: string }[] = [
    { value: 'file', label: s.portability.sourceFile },
    { value: 'path', label: s.import.sourcePath },
    { value: 'json', label: s.import.sourceJson },
  ];
  return (
    <div className="space-y-4">
      <SettingsSegmented
        ariaLabel={s.import.title}
        value={props.sourceKind}
        options={sourceOptions}
        onChange={props.onSourceKind}
      />

      {props.sourceKind === 'file' && (
        <SettingsField
          label={s.portability.fileLabel}
          htmlFor="mcp-import-file"
          hint={props.fileName || s.portability.fileHint}
        >
          <input
            id="mcp-import-file"
            type="file"
            accept="application/json,.json"
            onChange={(event) => void props.onFile(event.target.files?.[0])}
            className={cn(
              FIELD_CLASS,
              'h-auto cursor-pointer py-1 file:mr-3 file:cursor-pointer file:rounded-xs file:border-0 file:bg-fill-selected file:px-3 file:py-1 file:text-xs file:font-medium file:text-fg'
            )}
          />
        </SettingsField>
      )}
      {props.sourceKind === 'path' && (
        <SettingsField
          label={s.import.pathLabel}
          htmlFor="mcp-import-path"
          hint={s.import.pathHint}
        >
          <Input
            id="mcp-import-path"
            value={props.path}
            onChange={(event) => props.onPath(event.target.value)}
            placeholder={s.import.pathPlaceholder}
          />
        </SettingsField>
      )}
      {props.sourceKind === 'json' && (
        <SettingsField label={s.import.jsonLabel} htmlFor="mcp-import-json">
          <Textarea
            id="mcp-import-json"
            value={props.json}
            onChange={(event) => props.onJson(event.target.value)}
            placeholder={s.import.jsonPlaceholder}
            rows={10}
            className="font-mono text-xs"
          />
        </SettingsField>
      )}
    </div>
  );
}

interface PreviewStepProps {
  entries: McpPortabilityPreviewEntry[];
  decisions: Record<string, DecisionState>;
  onDecision: (entry: McpPortabilityPreviewEntry, decision: McpPortabilityDecision) => void;
  onReplaceTarget: (entryKey: string, targetServerId: string) => void;
  onSecretValue: (entryKey: string, kind: 'env' | 'header', name: string, value: string) => void;
}

function PreviewStep({
  entries,
  decisions,
  onDecision,
  onReplaceTarget,
  onSecretValue,
}: PreviewStepProps) {
  const { t } = useI18n();
  const s = t.settings.mcp;
  if (entries.length === 0) {
    return <EmptyState title={s.import.emptyPreview} className="min-h-0 py-4" />;
  }
  return (
    <div className="space-y-3">
      <h4 className="text-sm font-semibold text-fg">{s.portability.reviewTitle}</h4>
      {entries.map((entry, index) => {
        const state = decisions[entry.key];
        if (!state) return null;
        const eligibleReplacementCount = entry.conflicts.filter(
          (candidate) => !candidate.replaceBlockedBySlug
        ).length;
        return (
          <section key={entry.key} className="space-y-3 rounded-md border border-stroke p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-fg">{entry.name}</span>
                  {entry.transport && <Badge>{s.transports[entry.transport]}</Badge>}
                </div>
                <p className="truncate font-mono text-xs text-fg-muted">
                  {entry.slug} · {entry.command ?? entry.url ?? entry.key}
                </p>
              </div>
              <Select
                ariaLabel={s.portability.decisionLabel.replace('{name}', entry.name)}
                value={state.decision}
                disabled={entry.status === 'invalid'}
                onChange={(value) => onDecision(entry, value as McpPortabilityDecision)}
                className="w-full sm:w-44 sm:shrink-0"
                options={entry.allowedDecisions.map((decision) => ({
                  value: decision,
                  label: s.portability.decisions[decision],
                  disabled: decision === 'replace' && eligibleReplacementCount === 0,
                }))}
              />
            </div>

            {entry.status === 'invalid' && entry.reason && (
              <StatusNote tone="danger">{s.import.reasons[entry.reason]}</StatusNote>
            )}

            {entry.conflicts.length > 0 ? (
              <Callout tone="warning" title={s.portability.conflictsTitle}>
                <div className="space-y-2 text-xs">
                  {entry.conflicts.map((candidate) => {
                    const blockedMessage = candidate.replaceBlockedBySlug
                      ? formatReplaceBlockedBySlug(
                          s.portability.replaceBlockedBySlug,
                          candidate.replaceBlockedBySlug
                        )
                      : undefined;
                    return (
                      <div key={candidate.serverId}>
                        <div>
                          <span className="font-medium text-fg">{candidate.name}</span>
                          <span> ({candidate.slug}) · </span>
                          {candidate.keys.map((key) => s.portability.conflictKeys[key]).join(', ')}
                        </div>
                        {blockedMessage && (
                          <StatusNote tone="danger" className="mt-1" title={blockedMessage}>
                            {blockedMessage}
                          </StatusNote>
                        )}
                      </div>
                    );
                  })}
                </div>
              </Callout>
            ) : (
              <StatusNote tone="success">{s.portability.noConflicts}</StatusNote>
            )}

            {state.decision === 'replace' && entry.conflicts.length > 1 && (
              <SettingsField
                label={s.portability.replacementTargetLabel}
                htmlFor={`mcp-import-target-${index}`}
              >
                <Select
                  id={`mcp-import-target-${index}`}
                  // Choosing `replace` already picks the first *eligible*
                  // candidate, so this fallback only runs when every candidate
                  // is blocked — and then there is nothing true to name. The
                  // native list skipped disabled options here too; naming one
                  // would report a target the apply call never sends and that
                  // `canApplyPreview` has already refused.
                  value={state.targetServerId ?? ''}
                  placeholder={s.portability.replacementTargetNone}
                  onChange={(serverId) => onReplaceTarget(entry.key, serverId)}
                  ariaLabel={s.portability.replacementTargetLabel}
                  options={entry.conflicts.map((candidate) => {
                    const blockedMessage = candidate.replaceBlockedBySlug
                      ? formatReplaceBlockedBySlug(
                          s.portability.replaceBlockedBySlug,
                          candidate.replaceBlockedBySlug
                        )
                      : undefined;
                    return {
                      value: candidate.serverId,
                      label: `${candidate.name} (${candidate.slug})`,
                      // The blocked reason was crammed into the option's text
                      // because a native list has nowhere else to put it; the
                      // panel has a second line for exactly this.
                      description: blockedMessage,
                      disabled: blockedMessage !== undefined,
                    };
                  })}
                />
              </SettingsField>
            )}

            {state.decision === 'copy' && entry.copyName && entry.copySlug && (
              <StatusNote tone="info">
                {s.portability.copyIdentity
                  .replace('{name}', entry.copyName)
                  .replace('{slug}', entry.copySlug)}
              </StatusNote>
            )}

            {state.decision !== 'skip' && entry.secretReferences.length > 0 && (
              <div className="space-y-3 border-t border-stroke pt-3">
                {entry.secretReferences.map((reference) =>
                  reference.required ? (
                    <div key={`${reference.kind}:${reference.name}`} className="space-y-1">
                      <p className="text-xs text-fg-muted">
                        {s.portability.referenceSecretWarning.replace('{name}', reference.name)}
                      </p>
                      <Input
                        type="password"
                        aria-label={s.portability.secretValueLabel.replace(
                          '{name}',
                          reference.name
                        )}
                        value={
                          reference.kind === 'env'
                            ? (state.secretEnv[reference.name] ?? '')
                            : (state.headers[reference.name] ?? '')
                        }
                        onChange={(event) =>
                          onSecretValue(
                            entry.key,
                            reference.kind,
                            reference.name,
                            event.target.value
                          )
                        }
                      />
                    </div>
                  ) : (
                    <div
                      key={`${reference.kind}:${reference.name}`}
                      className="flex flex-wrap items-center gap-2"
                    >
                      <StatusNote tone="info">
                        {s.portability.literalSecretWarning.replace('{name}', reference.name)}
                      </StatusNote>
                      <Badge>{s.portability.redactedValue}</Badge>
                    </div>
                  )
                )}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

function canApplyPreview(step: Extract<Step, { kind: 'preview' }>): boolean {
  return step.entries.every((entry) => {
    const state = step.decisions[entry.key];
    if (!state || state.decision === 'skip') return true;
    if (state.decision === 'replace') {
      const target = entry.conflicts.find(
        (candidate) => candidate.serverId === state.targetServerId
      );
      if (!target || target.replaceBlockedBySlug) return false;
    }
    return entry.secretReferences.every((reference) => {
      if (!reference.required) return true;
      return reference.kind === 'env'
        ? Boolean(state.secretEnv[reference.name])
        : Boolean(state.headers[reference.name]);
    });
  });
}

function formatReplaceBlockedBySlug(
  template: string,
  blocker: NonNullable<McpPortabilityPreviewEntry['conflicts'][number]['replaceBlockedBySlug']>
): string {
  return template.replace('{slug}', blocker.slug).replace('{holderName}', blocker.holderName);
}

function SummaryStep({ summary }: { summary: McpPortabilityApplyResponse }) {
  const { t } = useI18n();
  const s = t.settings.mcp.portability;
  const values = [
    s.summaryAdded.replace('{count}', String(summary.added)),
    s.summaryReplaced.replace('{count}', String(summary.replaced)),
    s.summaryCopied.replace('{count}', String(summary.copied)),
    s.summarySkipped.replace('{count}', String(summary.skipped)),
    s.summaryInvalid.replace('{count}', String(summary.invalid)),
  ];
  return (
    <Callout tone="success" title={s.summaryTitle}>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {values.map((value) => (
          <li key={value}>{value}</li>
        ))}
      </ul>
    </Callout>
  );
}
