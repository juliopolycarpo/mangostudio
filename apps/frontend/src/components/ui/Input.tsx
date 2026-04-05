import type { InputHTMLAttributes } from 'react';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

export function Input({ label, error, id, className = '', ...props }: InputProps) {
  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <label htmlFor={id} className="text-sm font-medium text-on-surface-variant">
          {label}
        </label>
      )}
      <input
        id={id}
        className={`
          w-full rounded-xl px-4 py-2.5 text-sm
          bg-surface-container-high text-on-surface
          border border-outline-variant/20
          placeholder:text-on-surface/30
          focus:outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/20
          transition-colors
          ${error ? 'border-error/60' : ''}
          ${className}
        `.trim()}
        {...props}
      />
      {error && <p className="text-xs text-error">{error}</p>}
    </div>
  );
}
