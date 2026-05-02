import type { InputHTMLAttributes } from 'react';

interface ToggleProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label: string;
}

export function Toggle({ label, id, ...props }: ToggleProps) {
  const inputId = id ?? label.toLowerCase().replace(/\s+/g, '-');

  return (
    <label htmlFor={inputId} className="inline-flex items-center gap-3 cursor-pointer group">
      <input id={inputId} type="checkbox" role="switch" className="sr-only peer" {...props} />
      <span
        className="
          relative inline-block w-10 h-6 rounded-full
          bg-surface-container-lowest border border-outline-variant/20
          peer-checked:bg-primary peer-checked:border-primary/60
          transition-colors duration-200
          after:content-[''] after:absolute after:top-0.5 after:left-0.5
          after:w-5 after:h-5 after:rounded-full after:bg-on-surface after:shadow-sm
          after:transition-transform after:duration-200
          peer-checked:after:translate-x-4 peer-checked:after:bg-on-primary
          group-hover:after:scale-105
        "
      />
      <span className="text-sm text-on-surface select-none">{label}</span>
    </label>
  );
}
