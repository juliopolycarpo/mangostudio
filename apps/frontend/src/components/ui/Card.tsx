import type { ReactNode } from 'react';

interface CardProps {
  variant?: 'glass' | 'solid';
  className?: string;
  children: ReactNode;
}

const variantStyles: Record<NonNullable<CardProps['variant']>, string> = {
  glass: 'glass-panel',
  solid: 'bg-surface-container-high',
};

export function Card({ variant = 'solid', className = '', children }: CardProps) {
  return (
    <div
      className={`rounded-2xl border border-outline-variant/10 p-8 ${variantStyles[variant]} ${className}`}
    >
      {children}
    </div>
  );
}
