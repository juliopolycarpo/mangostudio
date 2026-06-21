import type { AgentProfile } from '@mangostudio/shared/agents';
import { AlertCircle, RotateCcw, Save, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import type { AgentEditorLabels, AgentEditorMode, EditableAgentProfile } from './AgentEditor.types';

interface AgentEditorHeaderProps {
  readonly title: string;
  readonly draft: EditableAgentProfile;
  readonly labels: AgentEditorLabels;
  readonly mode: AgentEditorMode;
  readonly dirty: boolean;
  readonly isUserAgent: boolean;
  readonly onFriendlyMode: () => void;
  readonly onRawMode: () => void;
}

export function AgentEditorHeader({
  title,
  draft,
  labels,
  mode,
  dirty,
  isUserAgent,
  onFriendlyMode,
  onRawMode,
}: AgentEditorHeaderProps) {
  return (
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
          <ModeToggleButton active={mode === 'friendly'} onClick={onFriendlyMode}>
            {labels.friendlyMode}
          </ModeToggleButton>
          <ModeToggleButton active={mode === 'raw'} onClick={onRawMode}>
            {labels.rawMode}
          </ModeToggleButton>
        </div>
      )}
    </div>
  );
}

interface ModeToggleButtonProps {
  readonly active: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}

function ModeToggleButton({ active, onClick, children }: ModeToggleButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-all duration-200 ${
        active
          ? 'bg-surface-container-high text-on-surface shadow-sm'
          : 'text-on-surface-variant/60 hover:text-on-surface'
      }`}
    >
      {children}
    </button>
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
        <Button type="button" variant="ghost" onClick={onReset}>
          <RotateCcw size={16} />
          {labels.reset}
        </Button>
        <Button type="button" loading={isSaving} disabled={!dirty && !isNew} onClick={onSave}>
          <Save size={16} />
          {isSaving ? labels.saving : labels.save}
        </Button>
      </div>
    </div>
  );
}

interface AgentResetDialogProps {
  readonly labels: AgentEditorLabels;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}

export function AgentResetDialog({ labels, onCancel, onConfirm }: AgentResetDialogProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <div className="w-full max-w-md rounded-2xl border border-outline-variant/20 bg-surface p-5 shadow-xl space-y-4">
        <div className="space-y-1">
          <h3 className="text-lg font-bold text-on-surface">{labels.confirmResetTitle}</h3>
          <p className="text-sm text-on-surface-variant/70">{labels.confirmResetDescription}</p>
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onCancel}>
            {labels.cancel}
          </Button>
          <Button type="button" variant="primary" onClick={onConfirm}>
            {labels.confirmReset}
          </Button>
        </div>
      </div>
    </div>
  );
}
