import type { ToolSettingsDescriptor } from '@mangostudio/shared/tool-settings';
import { Wrench } from 'lucide-react';

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
        <div className={`grid gap-2 sm:grid-cols-2 ${disabled ? 'opacity-50' : ''}`}>
          {tools.map((tool) => (
            <label
              key={tool.name}
              className={`flex items-start gap-2.5 rounded-xl border px-3 py-2.5 text-sm text-on-surface transition-all duration-200 ${
                disabled
                  ? 'border-outline-variant/10 bg-surface-container-lowest/50 cursor-not-allowed'
                  : selected.has(tool.name)
                    ? 'border-primary/30 bg-primary/5 cursor-pointer'
                    : 'border-outline-variant/20 bg-surface-container-lowest hover:border-outline-variant/40 hover:bg-surface-container-high cursor-pointer'
              }`}
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
                className="mt-0.5 accent-primary"
              />
              <span className="flex-1 min-w-0">
                <span className="flex items-center gap-1.5">
                  <Wrench size={12} className="shrink-0 text-on-surface-variant/50" />
                  <span className="block font-medium text-sm">{tool.title}</span>
                </span>
                <span className="block text-xs text-on-surface-variant/60 truncate">
                  {tool.name}
                </span>
              </span>
            </label>
          ))}
        </div>
      )}
    </fieldset>
  );
}
