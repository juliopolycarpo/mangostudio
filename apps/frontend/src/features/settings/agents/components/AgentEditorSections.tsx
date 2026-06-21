import type { AgentProfile, AgentRole } from '@mangostudio/shared/agents';
import { MAX_TOOL_ITERATIONS_MAX, MAX_TOOL_ITERATIONS_MIN } from '@mangostudio/shared/app-settings';
import type { ToolSettingsDescriptor } from '@mangostudio/shared/tool-settings';
import { Eye } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import type {
  AgentEditorLabels,
  EditableAgentProfile,
  ModelSelectOption,
} from './AgentEditor.types';
import { AgentMarkdownEditor } from './AgentMarkdownEditor';
import { AgentToolPicker } from './AgentToolPicker';

const ROLE_OPTIONS: ReadonlyArray<AgentRole> = ['primary', 'subagent', 'both'];
const REASONING_EFFORT_OPTIONS: ReadonlyArray<NonNullable<AgentProfile['reasoningEffort']>> = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

type UpdateDraft = (partial: Partial<EditableAgentProfile>) => void;

interface AgentRawMarkdownSectionProps {
  readonly labels: AgentEditorLabels;
  readonly rawMarkdown: string;
  readonly isPreviewing: boolean;
  readonly onChange: (markdown: string) => void;
  readonly onPreview: () => void;
}

export function AgentRawMarkdownSection({
  labels,
  rawMarkdown,
  isPreviewing,
  onChange,
  onPreview,
}: AgentRawMarkdownSectionProps) {
  return (
    <div className="space-y-3">
      <AgentMarkdownEditor label={labels.rawMarkdown} markdown={rawMarkdown} onChange={onChange} />
      <Button type="button" variant="secondary" loading={isPreviewing} onClick={onPreview}>
        <Eye size={16} />
        {isPreviewing ? labels.previewing : labels.preview}
      </Button>
    </div>
  );
}

interface AgentFriendlyEditorProps {
  readonly draft: EditableAgentProfile;
  readonly allAgents: ReadonlyArray<AgentProfile>;
  readonly tools: ReadonlyArray<ToolSettingsDescriptor>;
  readonly modelOptions: ReadonlyArray<ModelSelectOption>;
  readonly labels: AgentEditorLabels;
  readonly isNew: boolean;
  readonly isUserAgent: boolean;
  readonly onDraftChange: UpdateDraft;
}

export function AgentFriendlyEditor({
  draft,
  allAgents,
  tools,
  modelOptions,
  labels,
  isNew,
  isUserAgent,
  onDraftChange,
}: AgentFriendlyEditorProps) {
  const eligibleSubagents = allAgents.filter(
    (candidate) =>
      candidate.id !== draft.id && (candidate.role === 'subagent' || candidate.role === 'both')
  );
  const selectedSubagents = new Set(draft.subagentIds);
  const sourcePath = draft.source.type === 'markdown' ? draft.source.path : undefined;
  const modelOptionIds = new Set(modelOptions.map((option) => option.value));
  const resolvedModelOptions =
    draft.model && !modelOptionIds.has(draft.model)
      ? [{ value: draft.model, label: draft.model }, ...modelOptions]
      : modelOptions;

  return (
    <div className="space-y-6">
      <AgentIdentitySection
        draft={draft}
        labels={labels}
        isNew={isNew}
        onDraftChange={onDraftChange}
      />
      <AgentBehaviorSection
        draft={draft}
        labels={labels}
        modelOptions={resolvedModelOptions}
        onDraftChange={onDraftChange}
      />
      <AgentReasoningSection draft={draft} labels={labels} onDraftChange={onDraftChange} />
      <AgentToolsSection
        draft={draft}
        labels={labels}
        tools={tools}
        eligibleSubagents={eligibleSubagents}
        selectedSubagents={selectedSubagents}
        onDraftChange={onDraftChange}
      />
      {isUserAgent && sourcePath && <AgentSourcePathField label={labels.path} value={sourcePath} />}
    </div>
  );
}

interface AgentIdentitySectionProps {
  readonly draft: EditableAgentProfile;
  readonly labels: AgentEditorLabels;
  readonly isNew: boolean;
  readonly onDraftChange: UpdateDraft;
}

function AgentIdentitySection({ draft, labels, isNew, onDraftChange }: AgentIdentitySectionProps) {
  return (
    <AgentEditorSection title={labels.sectionIdentity}>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <TextField
          label={labels.name}
          value={draft.name}
          onChange={(name) => onDraftChange({ name })}
        />
        {isNew && (
          <TextField
            label={labels.slug}
            value={draft.slug ?? ''}
            onChange={(slug) => onDraftChange({ slug })}
          />
        )}
        <TextField
          label={labels.description}
          value={draft.description}
          onChange={(description) => onDraftChange({ description })}
        />
        <label className="block space-y-2">
          <span className="text-sm font-semibold text-on-surface">{labels.role}</span>
          <select
            value={draft.role}
            onChange={(event) => onDraftChange({ role: event.target.value as AgentRole })}
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
    </AgentEditorSection>
  );
}

interface AgentBehaviorSectionProps {
  readonly draft: EditableAgentProfile;
  readonly labels: AgentEditorLabels;
  readonly modelOptions: ReadonlyArray<ModelSelectOption>;
  readonly onDraftChange: UpdateDraft;
}

function AgentBehaviorSection({
  draft,
  labels,
  modelOptions,
  onDraftChange,
}: AgentBehaviorSectionProps) {
  return (
    <AgentEditorSection title={labels.sectionBehavior}>
      <label className="block space-y-2">
        <span className="text-sm font-semibold text-on-surface">{labels.systemPrompt}</span>
        <textarea
          value={draft.systemPrompt}
          onChange={(event) => onDraftChange({ systemPrompt: event.target.value })}
          rows={6}
          className="w-full rounded-xl border border-outline-variant/20 bg-surface-container-lowest px-3 py-2 text-sm text-on-surface focus:border-primary/60 focus:outline-none focus:ring-1 focus:ring-primary/20 resize-y"
        />
      </label>
      <label className="block space-y-2">
        <span className="text-sm font-semibold text-on-surface">{labels.model}</span>
        <select
          value={draft.model ?? ''}
          onChange={(event) =>
            onDraftChange({ model: event.target.value ? event.target.value : undefined })
          }
          className="w-full rounded-xl border border-outline-variant/20 bg-surface-container-lowest px-3 py-2 text-sm text-on-surface focus:border-primary/60 focus:outline-none focus:ring-1 focus:ring-primary/20"
        >
          <option value="">{labels.modelDefaultOption}</option>
          {modelOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    </AgentEditorSection>
  );
}

interface AgentReasoningSectionProps {
  readonly draft: EditableAgentProfile;
  readonly labels: AgentEditorLabels;
  readonly onDraftChange: UpdateDraft;
}

function AgentReasoningSection({ draft, labels, onDraftChange }: AgentReasoningSectionProps) {
  return (
    <AgentEditorSection title={labels.sectionReasoning}>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <label className="flex items-center gap-2 rounded-xl border border-outline-variant/20 bg-surface-container-lowest px-3 py-2 text-sm text-on-surface">
          <input
            type="checkbox"
            checked={draft.thinkingEnabled ?? false}
            onChange={(event) => onDraftChange({ thinkingEnabled: event.target.checked })}
            className="accent-primary"
          />
          {labels.thinking}
        </label>
        <label className="block space-y-2">
          <span className="text-sm font-semibold text-on-surface">{labels.reasoningEffort}</span>
          <select
            value={draft.reasoningEffort ?? ''}
            onChange={(event) =>
              onDraftChange({
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
          onChange={(maxToolIterations) => onDraftChange({ maxToolIterations })}
        />
      </div>
    </AgentEditorSection>
  );
}

interface AgentToolsSectionProps {
  readonly draft: EditableAgentProfile;
  readonly labels: AgentEditorLabels;
  readonly tools: ReadonlyArray<ToolSettingsDescriptor>;
  readonly eligibleSubagents: ReadonlyArray<AgentProfile>;
  readonly selectedSubagents: ReadonlySet<string>;
  readonly onDraftChange: UpdateDraft;
}

function AgentToolsSection({
  draft,
  labels,
  tools,
  eligibleSubagents,
  selectedSubagents,
  onDraftChange,
}: AgentToolsSectionProps) {
  return (
    <AgentEditorSection title={labels.sectionTools}>
      <label className="flex items-center gap-2 rounded-xl border border-outline-variant/20 bg-surface-container-lowest px-3 py-2 text-sm text-on-surface w-fit">
        <input
          type="checkbox"
          checked={draft.toolsEnabled}
          onChange={(event) => onDraftChange({ toolsEnabled: event.target.checked })}
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
        onChange={(toolNames) => onDraftChange({ toolNames })}
      />

      <fieldset className="space-y-2" disabled={eligibleSubagents.length === 0}>
        <legend className="text-sm font-semibold text-on-surface">{labels.subagents}</legend>
        {eligibleSubagents.length === 0 ? (
          <p className="text-sm text-on-surface-variant/60">{labels.noSubagents}</p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
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
                    onDraftChange({ subagentIds });
                  }}
                  className="accent-primary"
                />
                {subagent.name}
              </label>
            ))}
          </div>
        )}
      </fieldset>
    </AgentEditorSection>
  );
}

interface AgentEditorSectionProps {
  readonly title: string;
  readonly children: ReactNode;
}

function AgentEditorSection({ title, children }: AgentEditorSectionProps) {
  return (
    <section className="space-y-4">
      <h3 className="text-xs uppercase tracking-widest font-bold text-on-surface-variant/80 font-label">
        {title}
      </h3>
      {children}
    </section>
  );
}

interface AgentSourcePathFieldProps {
  readonly label: string;
  readonly value: string;
}

function AgentSourcePathField({ label, value }: AgentSourcePathFieldProps) {
  return (
    <label className="block space-y-2">
      <span className="text-sm font-semibold text-on-surface">{label}</span>
      <input
        readOnly
        value={value}
        className="w-full rounded-xl border border-outline-variant/20 bg-surface-container-lowest px-3 py-2 text-sm text-on-surface-variant"
      />
    </label>
  );
}

interface TextFieldProps {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
}

function TextField({ label, value, onChange, placeholder }: TextFieldProps) {
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

interface NumberFieldProps {
  readonly label: string;
  readonly value: number | '';
  readonly onChange: (value: number | undefined) => void;
}

function NumberField({ label, value, onChange }: NumberFieldProps) {
  return (
    <label className="block space-y-2">
      <span className="text-sm font-semibold text-on-surface">{label}</span>
      <input
        type="number"
        min={MAX_TOOL_ITERATIONS_MIN}
        max={MAX_TOOL_ITERATIONS_MAX}
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
