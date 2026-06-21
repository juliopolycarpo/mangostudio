import type { AgentProfile, AgentProfileUpsertBody } from '@mangostudio/shared/agents';
import { useCallback, useEffect, useState } from 'react';
import type { AgentEditorMode, AgentEditorProps, EditableAgentProfile } from './AgentEditor.types';
import { AgentEditorActionBar, AgentEditorHeader, AgentResetDialog } from './AgentEditorChrome';
import { AgentFriendlyEditor, AgentRawMarkdownSection } from './AgentEditorSections';

export type { EditableAgentProfile } from './AgentEditor.types';

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
  modelOptions,
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

  const handlePreviewMarkdown = useCallback(() => {
    void onPreviewMarkdown(rawMarkdown, draft.id).then((profile) => {
      setDraft({ ...profile, slug: draft.slug });
      setRawMarkdown(serializeAgentMarkdown(profile));
    });
  }, [draft.id, draft.slug, onPreviewMarkdown, rawMarkdown]);

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
      <AgentEditorHeader
        title={title}
        draft={draft}
        labels={labels}
        mode={mode}
        dirty={dirty}
        isUserAgent={isUserAgent}
        onFriendlyMode={() => setMode('friendly')}
        onRawMode={() => {
          setRawMarkdown(serializeAgentMarkdown(draft));
          setMode('raw');
        }}
      />

      <div className="p-4 sm:p-6 space-y-6">
        {mode === 'raw' && isUserAgent ? (
          <AgentRawMarkdownSection
            labels={labels}
            rawMarkdown={rawMarkdown}
            isPreviewing={isPreviewing}
            onChange={setRawMarkdown}
            onPreview={handlePreviewMarkdown}
          />
        ) : (
          <AgentFriendlyEditor
            draft={draft}
            allAgents={allAgents}
            tools={tools}
            modelOptions={modelOptions}
            labels={labels}
            isNew={isNew}
            isUserAgent={isUserAgent}
            onDraftChange={updateDraft}
          />
        )}
      </div>

      <AgentEditorActionBar
        draft={draft}
        labels={labels}
        isUserAgent={isUserAgent}
        isNew={isNew}
        isSaving={isSaving}
        dirty={dirty}
        onDelete={onDelete}
        onReset={handleReset}
        onSave={handleSave}
      />

      {showResetConfirm && (
        <AgentResetDialog
          labels={labels}
          onCancel={() => setShowResetConfirm(false)}
          onConfirm={confirmReset}
        />
      )}
    </div>
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
