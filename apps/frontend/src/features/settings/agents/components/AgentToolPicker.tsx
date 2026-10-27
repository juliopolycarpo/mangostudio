import type { ToolSettingsDescriptor } from '@mangostudio/shared/tool-settings';

import { CheckboxRow } from '@/components/settings/CheckboxRow';

interface AgentToolPickerProps {
  readonly label: string;
  readonly disabledLabel: string;
  readonly tools: ReadonlyArray<ToolSettingsDescriptor>;
  readonly selectedToolNames: ReadonlyArray<string>;
  readonly disabled?: boolean;
  readonly onChange: (toolNames: ReadonlyArray<string>) => void;
}

export function AgentToolPicker({
  label,
  disabledLabel,
  tools,
  selectedToolNames,
  disabled = false,
  onChange,
}: AgentToolPickerProps) {
  const selected = new Set(selectedToolNames);

  return (
    <fieldset className="space-y-2" disabled={disabled}>
      <legend className="text-sm font-medium text-fg">{label}</legend>
      {tools.length === 0 ? (
        <p className="text-sm text-fg-muted">{disabledLabel}</p>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {tools.map((tool) => (
            <CheckboxRow
              key={tool.name}
              label={tool.title}
              description={tool.name}
              checked={selected.has(tool.name)}
              onChange={(checked) =>
                onChange(
                  checked
                    ? [...selectedToolNames, tool.name]
                    : selectedToolNames.filter((name) => name !== tool.name)
                )
              }
            />
          ))}
        </div>
      )}
    </fieldset>
  );
}
