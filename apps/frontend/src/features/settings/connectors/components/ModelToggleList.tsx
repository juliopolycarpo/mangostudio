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
      <h4 className="text-[10px] uppercase tracking-widest font-bold text-fg-muted">{title}</h4>
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
          ? 'bg-accent-subtle border-accent'
          : 'bg-control border-stroke hover:border-stroke'
      }`}
    >
      <Checkbox
        checked={isEnabled}
        onChange={(event) => {
          void onToggleModel(model.modelId, event.target.checked);
        }}
      />
      <div className="space-y-0.5">
        <div className={`text-sm font-bold ${isEnabled ? 'text-accent-fg' : 'text-fg'}`}>
          {model.displayName}
        </div>
        <div className="text-[10px] font-mono text-fg-muted">{model.modelId}</div>
      </div>
    </label>
  );
}
