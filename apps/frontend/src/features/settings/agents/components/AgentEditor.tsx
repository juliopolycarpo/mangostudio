import { useState, useEffect, useCallback } from 'react';
import type {
  AgentId,
  AgentProfile,
  AgentProfileUpsertBody,
  AgentRole,
} from '@mangostudio/shared/agents';
import type { ToolSettingsDescriptor } from '@mangostudio/shared/tool-settings';
import { Eye, RotateCcw, Save, Trash2, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { AgentMarkdownEditor } from './AgentMarkdownEditor';
import { AgentToolPicker } from './AgentToolPicker';

type AgentEditorMode = 'friendly' | 'raw';

export interface EditableAgentProfile extends AgentProfile {
  readonly slug?: string;
}

interface AgentEditorLabels {
  readonly builtIn: string;
  readonly user: string;
  readonly createTitle: string;
  readonly name: string;
  readonly slug: string;
  readonly description: string;
  readonly role: string;
  readonly roles: Record<AgentRole, string>;
  readonly systemPrompt: string;
  readonly model: string;
  readonly thinking: string;
  readonly reasoningEffort: string;
  readonly reasoningEfforts: Record<NonNullable<AgentProfile['reasoningEffort']>, string>;
  readonly maxToolIterations: string;
  readonly toolsEnabled: string;
  readonly toolAllowlist: string;
  readonly noTools: string;
  readonly subagents: string;
  readonly noSubagents: string;
  readonly path: string;
  readonly friendlyMode: string;
  readonly rawMode: string;
  readonly rawMarkdown: string;
  readonly preview: string;
  readonly previewing: string;
  readonly save: string;
  readonly saving: string;
  readonly reset: string;
  readonly delete: string;
  readonly sectionIdentity: string;
  readonly sectionBehavior: string;
  readonly sectionReasoning: string;
  readonly sectionTools: string;
  readonly unsavedChanges: string;
  readonly confirmResetTitle: string;
  readonly confirmResetDescription: string;
  readonly confirmReset: string;
  readonly cancel: string;
}

interface AgentEditorProps {
  readonly agent: EditableAgentProfile;
  readonly allAgents: ReadonlyArray<AgentProfile>;
  readonly tools: ReadonlyArray<ToolSettingsDescriptor>;
  readonly labels: AgentEditorLabels;
  readonly isNew: boolean;
  readonly isSaving: boolean;
  readonly isPreviewing: boolean;
  readonly onSave: (agent: EditableAgentProfile, body: AgentProfileUpsertBody) => void;
  readonly onPreviewMarkdown: (markdown: string, agentId: AgentId) => Promise<AgentProfile>;
  readonly onDelete: (agent: AgentProfile) => void;
  readonly onCancelNew: () => void;
}

const ROLE_OPTIONS: ReadonlyArray<AgentRole> = ['primary', 'subagent', 'both'];
const REASONING_EFFORT_OPTIONS: ReadonlyArray<NonNullable<AgentProfile['reasoningEffort']>> = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

function areAgentsEqual(a: EditableAgentProfile, b: EditableAgentProfile): boolean {
  return (
    a.name === b.name &&
    a.description === b.description &&
    a.role === b.role &&
    a.systemPrompt === b.systemPrompt &&
    a.model === b.model &&
    a.thinkingEnabled === b.thinkingEnabled &&
    a.reasoningEffort === b.reasoningEffort &&
    a.maxToolIterations === b.maxToolIterations &&
    a.toolsEnabled === b.toolsEnabled &&
    JSON.stringify(a.toolNames) === JSON.stringify(b.toolNames) &&
    JSON.stringify(a.subagentIds) === JSON.stringify(b.subagentIds) &&
    a.slug === b.slug
  );
}

export function AgentEditor({
  agent,
  allAgents,
  tools,
  labels,
  isNew,
  isSaving,
  isPreviewing,
  onSave,
  onPreviewMarkdown,
  onDelete,
  onCancelNew,
}: AgentEditorProps) {
  const [draft, setDraft] = useState<EditableAgentProfile>(agent);
  const [mode, setMode] = useState<AgentEditorMode>('friendly');
  const [rawMarkdown, setRawMarkdown] = useState(() => serializeAgentMarkdown(agent));
  const [showResetConfirm, setShowResetConfirm] = useState(false);

  const dirty = !areAgentsEqual(draft, agent);
  const isUserAgent = draft.kind === 'user';
  const eligibleSubagents = allAgents.filter(
    (candidate) =>
      candidate.id !== draft.id && (candidate.role === 'subagent' || candidate.role === 'both')
  );
  const selectedSubagents = new Set(draft.subagentIds);
  const sourcePath = draft.source.type === 'markdown' ? draft.source.path : undefined;
  const title = isNew ? labels.createTitle : draft.name;

  const updateDraft = (partial: Partial<EditableAgentProfile>) => {
    setDraft((current) => ({ ...current, ...partial }));
  };

  const handleSave = useCallback(() => {
    onSave(draft, createUpsertBody(draft));
  }, [draft, onSave]);

  const handleReset = useCallback(() => {
    if (dirty) {
      setShowResetConfirm(true);
      return;
    }
    if (isNew) {
      onCancelNew();
      return;
    }
    setDraft(agent);
    setRawMarkdown(serializeAgentMarkdown(agent));
  }, [dirty, isNew, agent, onCancelNew]);

  const confirmReset = useCallback(() => {
    setShowResetConfirm(false);
    if (isNew) {
      onCancelNew();
      return;
    }
    setDraft(agent);
    setRawMarkdown(serializeAgentMarkdown(agent));
  }, [isNew, agent, onCancelNew]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 's') {
        event.preventDefault();
        if (!isSaving && dirty) {
          handleSave();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleSave, isSaving, dirty]);

  return (
    <div className="space-y-0 rounded-2xl border border-outline-variant/20 bg-surface-container-high">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between p-4 sm:p-6 border-b border-outline-variant/10">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-xl font-bold text-on-surface">{title}</h2>
            <span className="rounded-full bg-surface-container-lowest px-2 py-0.5 text-xs text-on-surface-variant">
              {draft.kind === 'builtin' ? labels.builtIn : labels.user}
            </span>
            {dirty && (
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-xs text-amber-600 dark:text-amber-400">
                <AlertCircle size={12} />
                {labels.unsavedChanges}
              </span>
            )}
          </div>
          <p className="mt-1 text-sm text-on-surface-variant/70 truncate">{draft.id}</p>
        </div>
        {isUserAgent && (
          <div className="flex gap-1 p-1 rounded-xl bg-surface-container-lowest border border-outline-variant/10 shrink-0">
            <button
              type="button"
              onClick={() => setMode('friendly')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-all duration-200 ${
                mode === 'friendly'
                  ? 'bg-surface-container-high text-on-surface shadow-sm'
                  : 'text-on-surface-variant/60 hover:text-on-surface'
              }`}
            >
              {labels.friendlyMode}
            </button>
            <button
              type="button"
              onClick={() => {
                setRawMarkdown(serializeAgentMarkdown(draft));
                setMode('raw');
              }}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-all duration-200 ${
                mode === 'raw'
                  ? 'bg-surface-container-high text-on-surface shadow-sm'
                  : 'text-on-surface-variant/60 hover:text-on-surface'
              }`}
            >
              {labels.rawMode}
            </button>
          </div>
        )}
      </div>

      {/* Body */}
      <div className="p-4 sm:p-6 space-y-6">
        {mode === 'raw' && isUserAgent ? (
          <div className="space-y-3">
            <AgentMarkdownEditor
              label={labels.rawMarkdown}
              markdown={rawMarkdown}
              onChange={setRawMarkdown}
            />
            <Button
              type="button"
              variant="secondary"
              loading={isPreviewing}
              onClick={() => {
                void onPreviewMarkdown(rawMarkdown, draft.id).then((profile) => {
                  setDraft({ ...profile, slug: draft.slug });
                  setRawMarkdown(serializeAgentMarkdown(profile));
                });
              }}
            >
              <Eye size={16} />
              {isPreviewing ? labels.previewing : labels.preview}
            </Button>
          </div>
        ) : (
          <div className="space-y-6">
            {/* Identity */}
            <section className="space-y-4">
              <h3 className="text-xs uppercase tracking-widest font-bold text-on-surface-variant/80 font-label">
                {labels.sectionIdentity}
              </h3>
              <div className="grid gap-3 sm:grid-cols-2">
                <TextField
                  label={labels.name}
                  value={draft.name}
                  onChange={(name) => updateDraft({ name })}
                />
                {isNew && (
                  <TextField
                    label={labels.slug}
                    value={draft.slug ?? ''}
                    onChange={(slug) => updateDraft({ slug })}
                  />
                )}
                <TextField
                  label={labels.description}
                  value={draft.description}
                  onChange={(description) => updateDraft({ description })}
                />
                <label className="block space-y-2">
                  <span className="text-sm font-semibold text-on-surface">{labels.role}</span>
                  <select
                    value={draft.role}
                    onChange={(event) => updateDraft({ role: event.target.value as AgentRole })}
                    className="w-full rounded-xl border border-outline-variant/20 bg-surface-container-lowest px-3 py-2 text-sm text-on-surface focus:border-primary/60 focus:outline-none focus:ring-1 focus:ring-primary/20"
                  >
                    {ROLE_OPTIONS.map((role) => (
                      <option key={role} value={role}>
                        {labels.roles[role]}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </section>

            {/* Behavior */}
            <section className="space-y-4">
              <h3 className="text-xs uppercase tracking-widest font-bold text-on-surface-variant/80 font-label">
                {labels.sectionBehavior}
              </h3>
              <label className="block space-y-2">
                <span className="text-sm font-semibold text-on-surface">{labels.systemPrompt}</span>
                <textarea
                  value={draft.systemPrompt}
                  onChange={(event) => updateDraft({ systemPrompt: event.target.value })}
                  rows={6}
                  className="w-full rounded-xl border border-outline-variant/20 bg-surface-container-lowest px-3 py-2 text-sm text-on-surface focus:border-primary/60 focus:outline-none focus:ring-1 focus:ring-primary/20 resize-y"
                />
              </label>
              <TextField
                label={labels.model}
                value={draft.model ?? ''}
                onChange={(model) => updateDraft({ model: model.trim() || undefined })}
                placeholder="e.g. gpt-4o"
              />
            </section>

            {/* Reasoning */}
            <section className="space-y-4">
              <h3 className="text-xs uppercase tracking-widest font-bold text-on-surface-variant/80 font-label">
                {labels.sectionReasoning}
              </h3>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="flex items-center gap-2 rounded-xl border border-outline-variant/20 bg-surface-container-lowest px-3 py-2 text-sm text-on-surface">
                  <input
                    type="checkbox"
                    checked={draft.thinkingEnabled ?? false}
                    onChange={(event) => updateDraft({ thinkingEnabled: event.target.checked })}
                    className="accent-primary"
                  />
                  {labels.thinking}
                </label>
                <label className="block space-y-2">
                  <span className="text-sm font-semibold text-on-surface">
                    {labels.reasoningEffort}
                  </span>
                  <select
                    value={draft.reasoningEffort ?? ''}
                    onChange={(event) =>
                      updateDraft({
                        reasoningEffort: event.target.value
                          ? (event.target.value as AgentProfile['reasoningEffort'])
                          : undefined,
                      })
                    }
                    className="w-full rounded-xl border border-outline-variant/20 bg-surface-container-lowest px-3 py-2 text-sm text-on-surface focus:border-primary/60 focus:outline-none focus:ring-1 focus:ring-primary/20"
                  >
                    <option value="" />
                    {REASONING_EFFORT_OPTIONS.map((effort) => (
                      <option key={effort} value={effort}>
                        {labels.reasoningEfforts[effort]}
                      </option>
                    ))}
                  </select>
                </label>
                <NumberField
                  label={labels.maxToolIterations}
                  value={draft.maxToolIterations ?? ''}
                  onChange={(maxToolIterations) => updateDraft({ maxToolIterations })}
                />
              </div>
            </section>

            {/* Tools */}
            <section className="space-y-4">
              <h3 className="text-xs uppercase tracking-widest font-bold text-on-surface-variant/80 font-label">
                {labels.sectionTools}
              </h3>
              <label className="flex items-center gap-2 rounded-xl border border-outline-variant/20 bg-surface-container-lowest px-3 py-2 text-sm text-on-surface w-fit">
                <input
                  type="checkbox"
                  checked={draft.toolsEnabled}
                  onChange={(event) => updateDraft({ toolsEnabled: event.target.checked })}
                  className="accent-primary"
                />
                {labels.toolsEnabled}
              </label>

              <AgentToolPicker
                label={labels.toolAllowlist}
                disabledLabel={labels.noTools}
                tools={tools}
                selectedToolNames={draft.toolNames}
                disabled={!draft.toolsEnabled}
                onChange={(toolNames) => updateDraft({ toolNames })}
              />

              <fieldset className="space-y-2" disabled={eligibleSubagents.length === 0}>
                <legend className="text-sm font-semibold text-on-surface">
                  {labels.subagents}
                </legend>
                {eligibleSubagents.length === 0 ? (
                  <p className="text-sm text-on-surface-variant/60">{labels.noSubagents}</p>
                ) : (
                  <div className="grid gap-2 sm:grid-cols-2">
                    {eligibleSubagents.map((subagent) => (
                      <label
                        key={subagent.id}
                        className="flex items-center gap-2 rounded-xl border border-outline-variant/20 bg-surface-container-lowest px-3 py-2 text-sm text-on-surface"
                      >
                        <input
                          type="checkbox"
                          checked={selectedSubagents.has(subagent.id)}
                          onChange={(event) => {
                            const subagentIds = event.target.checked
                              ? [...draft.subagentIds, subagent.id]
                              : draft.subagentIds.filter((id) => id !== subagent.id);
                            updateDraft({ subagentIds });
                          }}
                          className="accent-primary"
                        />
                        {subagent.name}
                      </label>
                    ))}
                  </div>
                )}
              </fieldset>
            </section>

            {isUserAgent && sourcePath && (
              <label className="block space-y-2">
                <span className="text-sm font-semibold text-on-surface">{labels.path}</span>
                <input
                  readOnly
                  value={sourcePath}
                  className="w-full rounded-xl border border-outline-variant/20 bg-surface-container-lowest px-3 py-2 text-sm text-on-surface-variant"
                />
              </label>
            )}
          </div>
        )}
      </div>

      {/* Sticky action bar */}
      <div className="sticky bottom-0 z-10 flex flex-wrap justify-between gap-2 border-t border-outline-variant/10 bg-surface-container-high/95 backdrop-blur-sm p-4 sm:p-6 rounded-b-2xl">
        <div>
          {isUserAgent && !isNew && (
            <Button type="button" variant="ghost" onClick={() => onDelete(draft)}>
              <Trash2 size={16} />
              {labels.delete}
            </Button>
          )}
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="ghost" onClick={handleReset}>
            <RotateCcw size={16} />
            {labels.reset}
          </Button>
          <Button type="button" loading={isSaving} disabled={!dirty && !isNew} onClick={handleSave}>
            <Save size={16} />
            {isSaving ? labels.saving : labels.save}
          </Button>
        </div>
      </div>

      {/* Reset confirmation dialog */}
      {showResetConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-md rounded-2xl border border-outline-variant/20 bg-surface p-5 shadow-xl space-y-4">
            <div className="space-y-1">
              <h3 className="text-lg font-bold text-on-surface">{labels.confirmResetTitle}</h3>
              <p className="text-sm text-on-surface-variant/70">{labels.confirmResetDescription}</p>
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setShowResetConfirm(false)}>
                {labels.cancel}
              </Button>
              <Button type="button" variant="primary" onClick={confirmReset}>
                {labels.confirmReset}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function TextField({
  label,
  value,
  onChange,
  placeholder,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
}) {
  return (
    <label className="block space-y-2">
      <span className="text-sm font-semibold text-on-surface">{label}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="w-full rounded-xl border border-outline-variant/20 bg-surface-container-lowest px-3 py-2 text-sm text-on-surface focus:border-primary/60 focus:outline-none focus:ring-1 focus:ring-primary/20"
      />
    </label>
  );
}

function NumberField({
  label,
  value,
  onChange,
}: {
  readonly label: string;
  readonly value: number | '';
  readonly onChange: (value: number | undefined) => void;
}) {
  return (
    <label className="block space-y-2">
      <span className="text-sm font-semibold text-on-surface">{label}</span>
      <input
        type="number"
        min={1}
        max={25}
        value={value}
        onChange={(event) => {
          const nextValue = Number(event.target.value);
          onChange(Number.isFinite(nextValue) && event.target.value ? nextValue : undefined);
        }}
        className="w-full rounded-xl border border-outline-variant/20 bg-surface-container-lowest px-3 py-2 text-sm text-on-surface focus:border-primary/60 focus:outline-none focus:ring-1 focus:ring-primary/20"
      />
    </label>
  );
}

function createUpsertBody(agent: EditableAgentProfile): AgentProfileUpsertBody {
  return {
    name: agent.name,
    description: agent.description,
    role: agent.role,
    systemPrompt: agent.systemPrompt,
    ...(agent.model ? { model: agent.model } : {}),
    ...(agent.thinkingEnabled !== undefined ? { thinkingEnabled: agent.thinkingEnabled } : {}),
    ...(agent.reasoningEffort ? { reasoningEffort: agent.reasoningEffort } : {}),
    ...(agent.maxToolIterations ? { maxToolIterations: agent.maxToolIterations } : {}),
    toolNames: agent.toolNames,
    toolsEnabled: agent.toolsEnabled,
    subagentIds: agent.subagentIds,
    metadata: agent.metadata,
  };
}

function serializeAgentMarkdown(agent: AgentProfile): string {
  const lines = [
    '---',
    `name: ${JSON.stringify(agent.name)}`,
    `description: ${JSON.stringify(agent.description)}`,
    `role: ${agent.role}`,
  ];
  if (agent.model) lines.push(`model: ${JSON.stringify(agent.model)}`);
  if (agent.toolNames.length > 0)
    lines.push('tools:', ...agent.toolNames.map((name) => `  - ${JSON.stringify(name)}`));
  if (agent.subagentIds.length > 0) {
    lines.push('subagents:', ...agent.subagentIds.map((id) => `  - ${JSON.stringify(id)}`));
  }
  lines.push('---', '', agent.systemPrompt, '');
  return lines.join('\n');
}
