import type { ModelOption } from '@mangostudio/shared/catalog';
import { Checkbox } from '@/components/ui/Checkbox';
import { MicroLabel } from '@/components/ui/MicroLabel';

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
    <div className="space-y-2">
      <MicroLabel as="h4" className="block">
        {title}
      </MicroLabel>
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

/** The checkbox is the whole signal: a checked box is the accent, the row stays neutral. */
function ModelToggleRow({ model, isEnabled, onToggleModel }: ModelToggleRowProps) {
  return (
    <label className="flex cursor-pointer items-center gap-3 rounded-sm border border-stroke bg-control px-3 py-2 transition-colors hover:bg-control-hover">
      <Checkbox
        checked={isEnabled}
        onChange={(event) => {
          void onToggleModel(model.modelId, event.target.checked);
        }}
      />
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-fg">{model.displayName}</span>
        <span className="block truncate font-mono text-micro text-fg-muted">{model.modelId}</span>
      </span>
    </label>
  );
}
