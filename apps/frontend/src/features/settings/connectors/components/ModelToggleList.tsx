import type { ModelOption } from '@mangostudio/shared/catalog';

import { CheckboxRow } from '@/components/settings/CheckboxRow';
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
          <CheckboxRow
            key={model.modelId}
            label={model.displayName}
            description={model.modelId}
            checked={enabledModelIds.has(model.modelId)}
            onChange={(checked) => {
              void onToggleModel(model.modelId, checked);
            }}
          />
        ))}
      </div>
    </div>
  );
}
