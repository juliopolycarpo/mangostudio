import type { ToolSettingsDescriptor } from '@mangostudio/shared/tool-settings';
import { Wrench } from 'lucide-react';
import { Checkbox } from '@/components/ui/Checkbox';

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
      <legend className="text-sm font-semibold text-fg">{label}</legend>
      {tools.length === 0 ? (
        <p className="text-sm text-fg-muted">{disabledLabel}</p>
      ) : (
        <div className={`grid gap-2 sm:grid-cols-2 ${disabled ? 'opacity-50' : ''}`}>
          {tools.map((tool) => (
            <label
              key={tool.name}
              className={`flex items-start gap-2.5 rounded-xl border px-3 py-2.5 text-sm text-fg transition-all duration-200 ${
                disabled
                  ? 'border-stroke bg-control cursor-not-allowed'
                  : selected.has(tool.name)
                    ? 'border-accent bg-accent-subtle cursor-pointer'
                    : 'border-stroke bg-control hover:border-stroke hover:bg-fill-hover cursor-pointer'
              }`}
            >
              <Checkbox
                checked={selected.has(tool.name)}
                onChange={(event) => {
                  const next = event.target.checked
                    ? [...selectedToolNames, tool.name]
                    : selectedToolNames.filter((name) => name !== tool.name);
                  onChange(next);
                }}
                className="mt-0.5"
              />
              <span className="flex-1 min-w-0">
                <span className="flex items-center gap-1.5">
                  <Wrench size={12} className="shrink-0 text-fg-subtle" />
                  <span className="block font-medium text-sm">{tool.title}</span>
                </span>
                <span className="block text-xs text-fg-muted truncate">{tool.name}</span>
              </span>
            </label>
          ))}
        </div>
      )}
    </fieldset>
  );
}
