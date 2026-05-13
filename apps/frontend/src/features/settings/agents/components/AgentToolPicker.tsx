import type { ToolSettingsDescriptor } from '@mangostudio/shared/tool-settings';

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
      <legend className="text-sm font-semibold text-on-surface">{label}</legend>
      {tools.length === 0 ? (
        <p className="text-sm text-on-surface-variant/60">{disabledLabel}</p>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {tools.map((tool) => (
            <label
              key={tool.name}
              className="flex items-start gap-2 rounded-xl border border-outline-variant/20 bg-surface-container-lowest px-3 py-2 text-sm text-on-surface"
            >
              <input
                type="checkbox"
                checked={selected.has(tool.name)}
                onChange={(event) => {
                  const next = event.target.checked
                    ? [...selectedToolNames, tool.name]
                    : selectedToolNames.filter((name) => name !== tool.name);
                  onChange(next);
                }}
                className="mt-1 accent-primary"
              />
              <span>
                <span className="block font-medium">{tool.title}</span>
                <span className="block text-xs text-on-surface-variant/60">{tool.name}</span>
              </span>
            </label>
          ))}
        </div>
      )}
    </fieldset>
  );
}
