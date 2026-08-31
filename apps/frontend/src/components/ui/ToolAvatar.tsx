/**
 * The chip that stands in for a tool: its own image, or its monogram on the
 * colour derived from its subject key.
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

import { type CSSProperties, useState } from 'react';
import { toolAvatarPalette } from './tool-avatar-palette';

export type ToolAvatarSize = '2xs' | 'xs' | 'sm' | 'md' | 'lg';

/**
 * A resolved image address and how it must be requested. Lives with the
 * component that renders it, since `remote` exists to decide two attributes.
 */
export interface ToolImageDisplay {
  readonly src: string;
  /** Loaded straight from a third-party host rather than from our API. */
  readonly remote: boolean;
}

/** The size/shape/type-scale classes for each avatar size, reusable by chips that draw beside one but aren't a `ToolAvatar` themselves. */
export const TOOL_AVATAR_SIZE_CLASS: Record<ToolAvatarSize, string> = {
  /** Inline in a chat timeline row, where a 20px avatar outweighs the status glyph. */
  '2xs': 'size-4 rounded-sm text-[8px]',
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
  /** Custom image, if the user set one. Absent means draw the monogram. */
  readonly image?: ToolImageDisplay | null;
  readonly size?: ToolAvatarSize;
  readonly className?: string;
}

export function ToolAvatar({
  subjectKey,
  monogram,
  name,
  image = null,
  size = 'md',
  className = '',
}: ToolAvatarProps) {
  // Tracked as the address that failed rather than as a flag, so pointing the
  // avatar at a different image gives that one its own chance to load.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  const palette = toolAvatarPalette(subjectKey);
  const style = {
    '--tool-avatar-bg-dark': palette.dark.bg,
    '--tool-avatar-fg-dark': palette.dark.fg,
    '--tool-avatar-bg-light': palette.light.bg,
    '--tool-avatar-fg-light': palette.light.fg,
  } as CSSProperties;

  // A remote address can rot, 404, or refuse to be embedded. None of that
  // should leave a hole where the tool used to be, so the monogram — which
  // needs nothing but the name — is what a failed load falls back to.
  const showImage = image !== null && image.src !== failedSrc;

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
      className={`inline-flex shrink-0 select-none items-center justify-center overflow-hidden font-bold uppercase leading-none ${TOOL_AVATAR_SIZE_CLASS[size]} ${className}`}
    >
      {showImage ? (
        <img
          src={image.src}
          alt=""
          loading="lazy"
          // A third-party host is told as little as possible: `no-referrer`
          // keeps which page drew the avatar out of the request. It stops there
          // on purpose — `crossorigin` would put the load in CORS mode, and a
          // host that serves images without `Access-Control-Allow-Origin` (most
          // of them) would fail it, so hotlinking would only ever draw the
          // monogram. Our own API is the opposite case: the bytes are behind the
          // session, so that request has to carry it.
          referrerPolicy={image.remote ? 'no-referrer' : undefined}
          crossOrigin={image.remote ? undefined : 'use-credentials'}
          onError={() => setFailedSrc(image.src)}
          className="size-full object-cover"
        />
      ) : (
        monogram
      )}
    </span>
  );
}
