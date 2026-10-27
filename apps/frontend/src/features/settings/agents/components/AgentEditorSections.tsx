import type { AgentProfile, AgentRole } from '@mangostudio/shared/agents';
import { MAX_TOOL_ITERATIONS_MAX, MAX_TOOL_ITERATIONS_MIN } from '@mangostudio/shared/app-settings';
import type { ToolSettingsDescriptor } from '@mangostudio/shared/tool-settings';
import { Eye } from 'lucide-react';
import { type ReactNode, useId } from 'react';

import { CheckboxRow } from '@/components/settings/CheckboxRow';
import { SettingsField } from '@/components/settings/SettingsField';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { Input } from '@/components/ui/Input';
import { MicroLabel } from '@/components/ui/MicroLabel';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { ICON_MD } from '@/lib/icon-sizes';

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
    <div className="space-y-4">
      <AgentMarkdownEditor label={labels.rawMarkdown} markdown={rawMarkdown} onChange={onChange} />
      <Button type="button" variant="secondary" loading={isPreviewing} onClick={onPreview}>
        <Eye size={ICON_MD} />
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
  const sourceId = useId();
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
      {isUserAgent && sourcePath && (
        <Input
          id={sourceId}
          label={labels.path}
          readOnly
          value={sourcePath}
          className="font-mono text-xs text-fg-muted"
        />
      )}
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
  const id = useId();
  return (
    <AgentEditorSection title={labels.sectionIdentity}>
      {/* The short fields share a row and the sentence spans both columns: half
          a row clipped the description mid-word and left a hole beside the role. */}
      <div className="grid gap-4 sm:grid-cols-2">
        <Input
          id={`${id}-name`}
          label={labels.name}
          value={draft.name}
          onChange={(event) => onDraftChange({ name: event.target.value })}
        />
        {isNew && (
          <Input
            id={`${id}-slug`}
            label={labels.slug}
            value={draft.slug ?? ''}
            onChange={(event) => onDraftChange({ slug: event.target.value })}
          />
        )}
        <SettingsField label={labels.role} htmlFor={`${id}-role`}>
          <Select
            id={`${id}-role`}
            value={draft.role}
            onChange={(value) => onDraftChange({ role: value as AgentRole })}
            ariaLabel={labels.role}
            options={ROLE_OPTIONS.map((role) => ({ value: role, label: labels.roles[role] }))}
          />
        </SettingsField>
        <div className="sm:col-span-2">
          <Input
            id={`${id}-description`}
            label={labels.agentDescription}
            value={draft.description}
            onChange={(event) => onDraftChange({ description: event.target.value })}
          />
        </div>
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
  const id = useId();
  return (
    <AgentEditorSection title={labels.sectionBehavior}>
      {/* An empty prompt is a real value (the built-in Default ships with one), so
          the hint says what the model then receives instead of leaving a blank box. */}
      <SettingsField
        label={labels.systemPrompt}
        htmlFor={`${id}-prompt`}
        hint={draft.systemPrompt.trim() ? undefined : labels.systemPromptEmptyHint}
      >
        <Textarea
          id={`${id}-prompt`}
          value={draft.systemPrompt}
          onChange={(event) => onDraftChange({ systemPrompt: event.target.value })}
          rows={6}
        />
      </SettingsField>
      <SettingsField label={labels.model} htmlFor={`${id}-model`}>
        <Select
          id={`${id}-model`}
          value={draft.model ?? ''}
          onChange={(value) => onDraftChange({ model: value ? value : undefined })}
          ariaLabel={labels.model}
          options={[{ value: '', label: labels.modelDefaultOption }, ...modelOptions]}
        />
      </SettingsField>
    </AgentEditorSection>
  );
}

interface AgentReasoningSectionProps {
  readonly draft: EditableAgentProfile;
  readonly labels: AgentEditorLabels;
  readonly onDraftChange: UpdateDraft;
}

function AgentReasoningSection({ draft, labels, onDraftChange }: AgentReasoningSectionProps) {
  const id = useId();
  return (
    <AgentEditorSection title={labels.sectionReasoning}>
      <CheckboxOption
        label={labels.thinking}
        checked={draft.thinkingEnabled ?? false}
        onChange={(thinkingEnabled) => onDraftChange({ thinkingEnabled })}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <SettingsField label={labels.reasoningEffort} htmlFor={`${id}-effort`}>
          <Select
            id={`${id}-effort`}
            value={draft.reasoningEffort ?? ''}
            onChange={(value) =>
              onDraftChange({
                reasoningEffort: value ? (value as AgentProfile['reasoningEffort']) : undefined,
              })
            }
            ariaLabel={labels.reasoningEffort}
            options={[
              // The blank row the native list had: it is how the field is put
              // back to "inherit", and it is the value the draft starts on.
              { value: '', label: labels.reasoningEffortDefaultOption },
              ...REASONING_EFFORT_OPTIONS.map((effort) => ({
                value: effort,
                label: labels.reasoningEfforts[effort],
              })),
            ]}
          />
        </SettingsField>
        <Input
          id={`${id}-iterations`}
          type="number"
          label={labels.maxToolIterations}
          min={MAX_TOOL_ITERATIONS_MIN}
          max={MAX_TOOL_ITERATIONS_MAX}
          value={draft.maxToolIterations ?? ''}
          onChange={(event) => {
            const nextValue = Number(event.target.value);
            onDraftChange({
              maxToolIterations:
                Number.isFinite(nextValue) && event.target.value ? nextValue : undefined,
            });
          }}
          className="w-32 text-center"
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
      <CheckboxOption
        label={labels.toolsEnabled}
        checked={draft.toolsEnabled}
        onChange={(toolsEnabled) => onDraftChange({ toolsEnabled })}
      />

      <AgentToolPicker
        label={labels.toolAllowlist}
        disabledLabel={labels.noTools}
        tools={tools}
        selectedToolNames={draft.toolNames}
        disabled={!draft.toolsEnabled}
        onChange={(toolNames) => onDraftChange({ toolNames })}
      />

      <fieldset className="space-y-2" disabled={eligibleSubagents.length === 0}>
        <legend className="text-sm font-medium text-fg">{labels.subagents}</legend>
        {eligibleSubagents.length === 0 ? (
          <p className="text-sm text-fg-muted">{labels.noSubagents}</p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {eligibleSubagents.map((subagent) => (
              <CheckboxRow
                key={subagent.id}
                label={subagent.name}
                checked={selectedSubagents.has(subagent.id)}
                onChange={(checked) => {
                  const subagentIds = checked
                    ? [...draft.subagentIds, subagent.id]
                    : draft.subagentIds.filter((id) => id !== subagent.id);
                  onDraftChange({ subagentIds });
                }}
              />
            ))}
          </div>
        )}
      </fieldset>
    </AgentEditorSection>
  );
}

interface CheckboxOptionProps {
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
}

/** A lone checkbox with its name to the right: an option of the form, submitted with Save. */
function CheckboxOption({ label, checked, onChange }: CheckboxOptionProps) {
  return (
    <label className="flex w-fit cursor-pointer items-center gap-2 text-sm text-fg">
      <Checkbox checked={checked} onChange={(event) => onChange(event.target.checked)} />
      {label}
    </label>
  );
}

interface AgentEditorSectionProps {
  readonly title: string;
  readonly children: ReactNode;
}

function AgentEditorSection({ title, children }: AgentEditorSectionProps) {
  return (
    <section className="space-y-4">
      <MicroLabel as="h4" className="block">
        {title}
      </MicroLabel>
      {children}
    </section>
  );
}
