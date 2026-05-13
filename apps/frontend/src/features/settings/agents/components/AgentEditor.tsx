import { useState } from 'react';
import type {
  AgentId,
  AgentProfile,
  AgentProfileUpsertBody,
  AgentRole,
} from '@mangostudio/shared/agents';
import type { ToolSettingsDescriptor } from '@mangostudio/shared/tool-settings';
import { Eye, RotateCcw, Save, Trash2 } from 'lucide-react';
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

  return (
    <div className="space-y-4 rounded-2xl border border-outline-variant/20 bg-surface-container-high p-4 sm:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-bold text-on-surface">{title}</h2>
            <span className="rounded-full bg-surface-container-lowest px-2 py-0.5 text-xs text-on-surface-variant">
              {draft.kind === 'builtin' ? labels.builtIn : labels.user}
            </span>
          </div>
          <p className="mt-1 text-sm text-on-surface-variant/70">{draft.id}</p>
        </div>
        {isUserAgent && (
          <div className="flex gap-2">
            <Button
              type="button"
              variant={mode === 'friendly' ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => setMode('friendly')}
            >
              {labels.friendlyMode}
            </Button>
            <Button
              type="button"
              variant={mode === 'raw' ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => {
                setRawMarkdown(serializeAgentMarkdown(draft));
                setMode('raw');
              }}
            >
              {labels.rawMode}
            </Button>
          </div>
        )}
      </div>

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
        <div className="space-y-4">
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
            <TextField
              label={labels.model}
              value={draft.model ?? ''}
              onChange={(model) => updateDraft({ model: model.trim() || undefined })}
            />
          </div>

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

          <label className="block space-y-2">
            <span className="text-sm font-semibold text-on-surface">{labels.systemPrompt}</span>
            <textarea
              value={draft.systemPrompt}
              onChange={(event) => updateDraft({ systemPrompt: event.target.value })}
              rows={8}
              className="w-full rounded-xl border border-outline-variant/20 bg-surface-container-lowest px-3 py-2 text-sm text-on-surface focus:border-primary/60 focus:outline-none focus:ring-1 focus:ring-primary/20"
            />
          </label>

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
            <label className="flex items-center gap-2 rounded-xl border border-outline-variant/20 bg-surface-container-lowest px-3 py-2 text-sm text-on-surface">
              <input
                type="checkbox"
                checked={draft.toolsEnabled}
                onChange={(event) => updateDraft({ toolsEnabled: event.target.checked })}
                className="accent-primary"
              />
              {labels.toolsEnabled}
            </label>
          </div>

          <AgentToolPicker
            label={labels.toolAllowlist}
            disabledLabel={labels.noTools}
            tools={tools}
            selectedToolNames={draft.toolNames}
            disabled={!draft.toolsEnabled}
            onChange={(toolNames) => updateDraft({ toolNames })}
          />

          <fieldset className="space-y-2" disabled={eligibleSubagents.length === 0}>
            <legend className="text-sm font-semibold text-on-surface">{labels.subagents}</legend>
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

      <div className="flex flex-wrap justify-between gap-2 border-t border-outline-variant/20 pt-4">
        <div>
          {isUserAgent && !isNew && (
            <Button type="button" variant="ghost" onClick={() => onDelete(draft)}>
              <Trash2 size={16} />
              {labels.delete}
            </Button>
          )}
        </div>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              if (isNew) onCancelNew();
              setDraft(agent);
              setRawMarkdown(serializeAgentMarkdown(agent));
            }}
          >
            <RotateCcw size={16} />
            {labels.reset}
          </Button>
          <Button
            type="button"
            loading={isSaving}
            onClick={() => onSave(draft, createUpsertBody(draft))}
          >
            <Save size={16} />
            {isSaving ? labels.saving : labels.save}
          </Button>
        </div>
      </div>
    </div>
  );
}

function TextField({
  label,
  value,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  return (
    <label className="block space-y-2">
      <span className="text-sm font-semibold text-on-surface">{label}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
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
