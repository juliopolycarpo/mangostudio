/** Conflict-aware MCP portability import with explicit per-entry decisions. */

import type {
  McpPortabilityApplyResponse,
  McpPortabilityDecision,
  McpPortabilityPreviewEntry,
  PreviewMcpPortabilityImportBody,
} from '@mangostudio/shared/mcp';
import { AlertTriangle, CheckCircle2, X } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useI18n } from '@/hooks/use-i18n';
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
      onError: (error) => setSubmitError(error.message),
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
        onError: (error) => setSubmitError(error.message),
      }
    );
  };

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    setFileName(file.name);
    setJson(await file.text());
    setSubmitError(null);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-surface-container-high w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-3xl p-5 sm:p-8 shadow-2xl border border-outline-variant/20 space-y-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h3 className="text-xl font-bold text-on-surface">{s.import.title}</h3>
            <p className="mt-1 text-sm text-on-surface-variant/70">
              {s.portability.importDescription}
            </p>
          </div>
          <Button variant="ghost" size="sm" aria-label={s.cancelButton} onClick={onClose}>
            <X size={16} />
          </Button>
        </div>

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

        {submitError && <p className="text-sm text-error">{submitError}</p>}

        <div className="flex gap-3 pt-2">
          {step.kind === 'source' && (
            <>
              <Button variant="secondary" className="flex-1" onClick={onClose}>
                {s.cancelButton}
              </Button>
              <Button
                className="flex-1"
                loading={previewMutation.isPending}
                onClick={handlePreview}
              >
                {previewMutation.isPending ? s.import.previewingButton : s.import.previewButton}
              </Button>
            </>
          )}
          {step.kind === 'preview' && (
            <>
              <Button
                variant="secondary"
                className="flex-1"
                onClick={() => {
                  setSubmitError(null);
                  setStep({ kind: 'source' });
                }}
              >
                {s.import.backButton}
              </Button>
              <Button
                className="flex-1"
                disabled={!canApplyPreview(step)}
                loading={applyMutation.isPending}
                onClick={handleApply}
              >
                {applyMutation.isPending ? s.portability.applying : s.portability.applyButton}
              </Button>
            </>
          )}
          {step.kind === 'summary' && (
            <Button className="flex-1" onClick={onClose}>
              {s.portability.done}
            </Button>
          )}
        </div>
      </div>
    </div>
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
  const labels = {
    file: s.portability.sourceFile,
    path: s.import.sourcePath,
    json: s.import.sourceJson,
  };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {(['file', 'path', 'json'] as const).map((kind) => (
          <button
            key={kind}
            type="button"
            onClick={() => props.onSourceKind(kind)}
            className={`px-4 py-2 text-sm font-medium rounded-xl border transition-colors ${
              props.sourceKind === kind
                ? 'bg-primary/10 border-primary/60 text-primary'
                : 'bg-surface-container-high border-outline-variant/20 text-on-surface-variant hover:text-on-surface'
            }`}
          >
            {labels[kind]}
          </button>
        ))}
      </div>

      {props.sourceKind === 'file' && (
        <div className="space-y-1.5">
          <label htmlFor="mcp-import-file" className="text-sm font-medium text-on-surface-variant">
            {s.portability.fileLabel}
          </label>
          <input
            id="mcp-import-file"
            type="file"
            accept="application/json,.json"
            onChange={(event) => void props.onFile(event.target.files?.[0])}
            className="block w-full rounded-xl border border-outline-variant/20 px-3 py-2 text-sm text-on-surface file:mr-3 file:rounded-lg file:border-0 file:bg-primary/10 file:px-3 file:py-1.5 file:text-primary"
          />
          <p className="text-xs text-on-surface-variant/60">
            {props.fileName || s.portability.fileHint}
          </p>
        </div>
      )}
      {props.sourceKind === 'path' && (
        <div className="space-y-1.5">
          <Input
            id="mcp-import-path"
            label={s.import.pathLabel}
            value={props.path}
            onChange={(event) => props.onPath(event.target.value)}
            placeholder={s.import.pathPlaceholder}
          />
          <p className="text-xs text-on-surface-variant/60">{s.import.pathHint}</p>
        </div>
      )}
      {props.sourceKind === 'json' && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor="mcp-import-json" className="text-sm font-medium text-on-surface-variant">
            {s.import.jsonLabel}
          </label>
          <textarea
            id="mcp-import-json"
            value={props.json}
            onChange={(event) => props.onJson(event.target.value)}
            placeholder={s.import.jsonPlaceholder}
            rows={10}
            className="rounded-xl px-3 py-2 text-sm font-mono bg-surface-container-high text-on-surface border border-outline-variant/20 placeholder:text-on-surface/30 focus:outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/20 transition-colors resize-y"
          />
        </div>
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
    return (
      <p className="py-6 text-center text-sm text-on-surface-variant/60">{s.import.emptyPreview}</p>
    );
  }
  return (
    <div className="space-y-3">
      <h4 className="text-sm font-semibold uppercase tracking-wider text-on-surface-variant/70">
        {s.portability.reviewTitle}
      </h4>
      {entries.map((entry) => {
        const state = decisions[entry.key];
        if (!state) return null;
        const eligibleReplacementCount = entry.conflicts.filter(
          (candidate) => !candidate.replaceBlockedBySlug
        ).length;
        return (
          <section
            key={entry.key}
            className="rounded-2xl border border-outline-variant/20 p-4 space-y-3"
          >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-on-surface">{entry.name}</span>
                  {entry.transport && (
                    <span className="rounded-full bg-surface-container-highest px-2 py-0.5 text-xs text-on-surface-variant">
                      {s.transports[entry.transport]}
                    </span>
                  )}
                </div>
                <p className="truncate text-xs font-mono text-on-surface-variant/60">
                  {entry.slug} · {entry.command ?? entry.url ?? entry.key}
                </p>
              </div>
              <select
                aria-label={s.portability.decisionLabel.replace('{name}', entry.name)}
                value={state.decision}
                disabled={entry.status === 'invalid'}
                onChange={(event) =>
                  onDecision(entry, event.target.value as McpPortabilityDecision)
                }
                className="rounded-xl border border-outline-variant/30 bg-surface-container-high px-3 py-2 text-sm text-on-surface focus:border-primary/60 focus:outline-none"
              >
                {entry.allowedDecisions.map((decision) => (
                  <option
                    key={decision}
                    value={decision}
                    disabled={decision === 'replace' && eligibleReplacementCount === 0}
                  >
                    {s.portability.decisions[decision]}
                  </option>
                ))}
              </select>
            </div>

            {entry.status === 'invalid' && entry.reason && (
              <p className="flex items-center gap-2 text-xs text-error">
                <AlertTriangle size={13} />
                {s.import.reasons[entry.reason]}
              </p>
            )}

            {entry.conflicts.length > 0 ? (
              <div className="rounded-xl bg-surface-container-low p-3 space-y-2">
                <p className="text-xs font-semibold text-on-surface-variant">
                  {s.portability.conflictsTitle}
                </p>
                {entry.conflicts.map((candidate) => {
                  const blockedMessage = candidate.replaceBlockedBySlug
                    ? formatReplaceBlockedBySlug(
                        s.portability.replaceBlockedBySlug,
                        candidate.replaceBlockedBySlug
                      )
                    : undefined;
                  return (
                    <div key={candidate.serverId} className="text-xs text-on-surface-variant/80">
                      <div>
                        <span className="font-medium text-on-surface">{candidate.name}</span>
                        <span> ({candidate.slug}) · </span>
                        {candidate.keys.map((key) => s.portability.conflictKeys[key]).join(', ')}
                      </div>
                      {blockedMessage && (
                        <p
                          className="mt-1 flex items-center gap-1.5 text-error"
                          title={blockedMessage}
                        >
                          <AlertTriangle size={12} />
                          {blockedMessage}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="flex items-center gap-2 text-xs text-on-surface-variant/60">
                <CheckCircle2 size={13} className="text-primary" />
                {s.portability.noConflicts}
              </p>
            )}

            {state.decision === 'replace' && entry.conflicts.length > 1 && (
              <label className="block space-y-1.5 text-xs text-on-surface-variant">
                <span>{s.portability.replacementTargetLabel}</span>
                <select
                  value={state.targetServerId}
                  onChange={(event) => onReplaceTarget(entry.key, event.target.value)}
                  className="w-full rounded-xl border border-outline-variant/20 bg-surface-container-high px-3 py-2 text-sm text-on-surface focus:border-primary/60 focus:outline-none"
                >
                  {entry.conflicts.map((candidate) => {
                    const blockedMessage = candidate.replaceBlockedBySlug
                      ? formatReplaceBlockedBySlug(
                          s.portability.replaceBlockedBySlug,
                          candidate.replaceBlockedBySlug
                        )
                      : undefined;
                    return (
                      <option
                        key={candidate.serverId}
                        value={candidate.serverId}
                        disabled={blockedMessage !== undefined}
                        title={blockedMessage}
                      >
                        {candidate.name} ({candidate.slug})
                        {blockedMessage ? ` — ${blockedMessage}` : ''}
                      </option>
                    );
                  })}
                </select>
              </label>
            )}

            {state.decision === 'copy' && entry.copyName && entry.copySlug && (
              <p className="text-xs text-primary">
                {s.portability.copyIdentity
                  .replace('{name}', entry.copyName)
                  .replace('{slug}', entry.copySlug)}
              </p>
            )}

            {state.decision !== 'skip' && entry.secretReferences.length > 0 && (
              <div className="space-y-2 border-t border-outline-variant/15 pt-3">
                {entry.secretReferences.map((reference) =>
                  reference.required ? (
                    <div key={`${reference.kind}:${reference.name}`} className="space-y-1.5">
                      <p className="text-xs text-on-surface-variant">
                        {s.portability.referenceSecretWarning.replace('{name}', reference.name)}
                      </p>
                      <input
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
                        className="w-full rounded-xl border border-outline-variant/20 bg-surface-container-high px-3 py-2 text-sm text-on-surface focus:border-primary/60 focus:outline-none"
                      />
                    </div>
                  ) : (
                    <p
                      key={`${reference.kind}:${reference.name}`}
                      className="flex items-center gap-2 text-xs text-on-surface-variant"
                    >
                      <AlertTriangle size={13} className="text-tertiary" />
                      {s.portability.literalSecretWarning.replace('{name}', reference.name)}
                      <span className="rounded-full bg-tertiary/10 px-2 py-0.5 text-tertiary">
                        {s.portability.redactedValue}
                      </span>
                    </p>
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
    <div className="rounded-2xl border border-primary/20 bg-primary/5 p-5">
      <div className="flex items-center gap-2 text-primary">
        <CheckCircle2 size={18} />
        <h4 className="font-semibold">{s.summaryTitle}</h4>
      </div>
      <ul className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
        {values.map((value) => (
          <li
            key={value}
            className="rounded-xl bg-surface-container-high px-3 py-2 text-xs text-on-surface-variant"
          >
            {value}
          </li>
        ))}
      </ul>
    </div>
  );
}
