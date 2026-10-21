import type { ReactNode } from 'react';

interface SettingsFieldProps {
  /** The field's name, always visible above the control (`text-sm`, 500). */
  readonly label: ReactNode;
  /** Id of the control: the name becomes a `<label htmlFor>`. Omit for a group of controls that name themselves. */
  readonly htmlFor?: string;
  /** One sentence under the control (`text-xs`, `fg-muted`). */
  readonly hint?: ReactNode;
  /** The control: an `Input`, a `Select`, a `Textarea`, a list of rows. */
  readonly children: ReactNode;
}

const LABEL = 'text-sm font-medium text-fg';

/**
 * One form field in a record editor: the name above, the control, the hint
 * below. `Input` already draws its own label and error; this is the same face
 * for the controls that do not (`Select`, `Textarea`, a list of rows) and for an
 * `Input` that needs a hint, so every field in an editor aligns the same way.
 *
 * // Usage:
 * <SettingsField label={s.environmentLabel} htmlFor="env" hint={s.environmentHint}>
 *   <Select id="env" value={id} options={options} onChange={setId} ariaLabel={s.environmentLabel} />
 * </SettingsField>
 */
export function SettingsField({ label, htmlFor, hint, children }: SettingsFieldProps) {
  return (
    <div className="flex flex-col gap-1">
      {htmlFor ? (
        <label htmlFor={htmlFor} className={LABEL}>
          {label}
        </label>
      ) : (
        <span className={LABEL}>{label}</span>
      )}
      {children}
      {hint ? <p className="text-xs text-fg-muted">{hint}</p> : null}
    </div>
  );
}
