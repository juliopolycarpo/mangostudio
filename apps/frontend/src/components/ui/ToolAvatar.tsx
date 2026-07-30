/**
 * The chip that stands in for a tool: its monogram on the colour derived from
 * its subject key.
 *
 * Both themes' colours are handed down as custom properties and CSS picks one
 * (see the `[data-tool-avatar]` rules in `index.css`). Doing it that way keeps
 * the palette a single TypeScript source of truth without making the component
 * depend on the theme context — an avatar renders correctly in any tree,
 * including tests that mount it bare.
 *
 * The monogram is user content and is rendered as text. It is never injected as
 * markup, and it never widens beyond the two characters the contract allows.
 *
 * The chip itself is decorative: it always sits beside the name it stands for,
 * so it carries a tooltip rather than an accessible label it would only repeat.
 */

import type { CSSProperties } from 'react';
import { toolAvatarPalette } from './tool-avatar-palette';

export type ToolAvatarSize = 'xs' | 'sm' | 'md' | 'lg';

const SIZE_CLASS: Record<ToolAvatarSize, string> = {
  /** Dense lists — the capability inspector, where rows are 11px tall text. */
  xs: 'size-5 rounded-md text-[9px]',
  sm: 'size-6 rounded-lg text-[10px]',
  md: 'size-9 rounded-xl text-xs',
  lg: 'size-12 rounded-2xl text-base',
};

interface ToolAvatarProps {
  /** `<kind>:<id>` — the colour source, stable across renames. */
  readonly subjectKey: string;
  readonly monogram: string;
  /** Effective tool name, shown on hover. */
  readonly name: string;
  readonly size?: ToolAvatarSize;
  readonly className?: string;
}

export function ToolAvatar({
  subjectKey,
  monogram,
  name,
  size = 'md',
  className = '',
}: ToolAvatarProps) {
  const palette = toolAvatarPalette(subjectKey);
  const style = {
    '--tool-avatar-bg-dark': palette.dark.bg,
    '--tool-avatar-fg-dark': palette.dark.fg,
    '--tool-avatar-bg-light': palette.light.bg,
    '--tool-avatar-fg-light': palette.light.fg,
  } as CSSProperties;

  return (
    <span
      data-tool-avatar
      data-subject-key={subjectKey}
      data-palette-slot={palette.slot}
      style={style}
      // Decorative: every surface prints the name next to the chip, so
      // announcing it here would say the tool's name twice.
      aria-hidden="true"
      title={name}
      className={`inline-flex shrink-0 select-none items-center justify-center font-bold uppercase leading-none ${SIZE_CLASS[size]} ${className}`}
    >
      {monogram}
    </span>
  );
}
