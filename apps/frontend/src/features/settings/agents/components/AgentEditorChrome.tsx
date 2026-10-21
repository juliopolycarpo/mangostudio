import type { AgentProfile } from '@mangostudio/shared/agents';
import { CircleAlert, RotateCcw, Save, Trash2 } from 'lucide-react';
import { SettingsSegmented } from '@/components/settings/SettingsSegmented';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ICON_MD, ICON_SM } from '@/lib/icon-sizes';
import type { AgentEditorLabels, AgentEditorMode, EditableAgentProfile } from './AgentEditor.types';

interface AgentEditorHeaderProps {
  readonly title: string;
  readonly draft: EditableAgentProfile;
  readonly labels: AgentEditorLabels;
  readonly mode: AgentEditorMode;
  readonly dirty: boolean;
  readonly isUserAgent: boolean;
  readonly onModeChange: (mode: AgentEditorMode) => void;
}

export function AgentEditorHeader({
  title,
  draft,
  labels,
  mode,
  dirty,
  isUserAgent,
  onModeChange,
}: AgentEditorHeaderProps) {
  return (
    <div className="flex flex-col gap-3 border-b border-stroke p-4 sm:flex-row sm:items-start sm:justify-between sm:p-6">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-base font-semibold text-fg">{title}</h3>
          <Badge>{draft.kind === 'builtin' ? labels.builtIn : labels.user}</Badge>
          {dirty && (
            <Badge variant="warning">
              <CircleAlert size={ICON_SM} aria-hidden="true" />
              {labels.unsavedChanges}
            </Badge>
          )}
        </div>
        <p className="truncate font-mono text-xs text-fg-muted">{draft.id}</p>
      </div>
      {isUserAgent && (
        <SettingsSegmented
          ariaLabel={`${labels.friendlyMode} / ${labels.rawMode}`}
          value={mode}
          options={[
            { value: 'friendly', label: labels.friendlyMode },
            { value: 'raw', label: labels.rawMode },
          ]}
          onChange={onModeChange}
        />
      )}
    </div>
  );
}

interface AgentEditorActionBarProps {
  readonly draft: EditableAgentProfile;
  readonly labels: AgentEditorLabels;
  readonly isUserAgent: boolean;
  readonly isNew: boolean;
  readonly isSaving: boolean;
  readonly dirty: boolean;
  readonly onDelete: (agent: AgentProfile) => void;
  readonly onReset: () => void;
  readonly onSave: () => void;
}

export function AgentEditorActionBar({
  draft,
  labels,
  isUserAgent,
  isNew,
  isSaving,
  dirty,
  onDelete,
  onReset,
  onSave,
}: AgentEditorActionBarProps) {
  return (
    <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-2 rounded-b-md border-t border-stroke bg-surface px-4 py-3 sm:px-6">
      <div>
        {isUserAgent && !isNew && (
          <Button
            type="button"
            variant="subtle"
            className="text-danger"
            onClick={() => onDelete(draft)}
          >
            <Trash2 size={ICON_MD} />
            {labels.delete}
          </Button>
        )}
      </div>
      <div className="flex gap-2">
        <Button type="button" variant="secondary" onClick={onReset}>
          <RotateCcw size={ICON_MD} />
          {labels.reset}
        </Button>
        <Button type="button" loading={isSaving} disabled={!dirty && !isNew} onClick={onSave}>
          <Save size={ICON_MD} />
          {isSaving ? labels.saving : labels.save}
        </Button>
      </div>
    </div>
  );
}
