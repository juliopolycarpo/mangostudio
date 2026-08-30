import type { ModelOption } from '@mangostudio/shared/catalog';
import { Checkbox } from '@/components/ui/Checkbox';

interface ModelToggleListProps {
  readonly title: string;
  readonly models: readonly ModelOption[];
  readonly enabledModelIds: ReadonlySet<string>;
  readonly onToggleModel: (modelId: string, checked: boolean) => void | Promise<void>;
}

/** Renders a connector model group with stable checkbox behavior. */
export function ModelToggleList({
  title,
  models,
  enabledModelIds,
  onToggleModel,
}: ModelToggleListProps) {
  if (models.length === 0) return null;

  return (
    <div className="space-y-3">
      <h4 className="text-[10px] uppercase tracking-widest font-bold text-on-surface-variant/60">
        {title}
      </h4>
      <div className="grid grid-cols-1 gap-2">
        {models.map((model) => (
          <ModelToggleRow
            key={model.modelId}
            model={model}
            isEnabled={enabledModelIds.has(model.modelId)}
            onToggleModel={onToggleModel}
          />
        ))}
      </div>
    </div>
  );
}

interface ModelToggleRowProps {
  readonly model: ModelOption;
  readonly isEnabled: boolean;
  readonly onToggleModel: (modelId: string, checked: boolean) => void | Promise<void>;
}

function ModelToggleRow({ model, isEnabled, onToggleModel }: ModelToggleRowProps) {
  return (
    <label
      className={`flex items-center gap-4 p-4 rounded-xl border cursor-pointer transition-all ${
        isEnabled
          ? 'bg-primary/10 border-primary/30'
          : 'bg-surface-container-lowest border-outline-variant/10 hover:border-outline-variant/30'
      }`}
    >
      <Checkbox
        checked={isEnabled}
        onChange={(event) => {
          void onToggleModel(model.modelId, event.target.checked);
        }}
      />
      <div className="space-y-0.5">
        <div className={`text-sm font-bold ${isEnabled ? 'text-primary' : 'text-on-surface'}`}>
          {model.displayName}
        </div>
        <div className="text-[10px] font-mono text-on-surface-variant/60">{model.modelId}</div>
      </div>
    </label>
  );
}
