import { useState, type SyntheticEvent } from 'react';

// Default aspect ratio used while the image's natural dimensions are still
// unknown. A square keeps the virtualized chat row height stable so that the
// asynchronous image load cannot shift surrounding content — the original
// source of the scroll-to-bottom flicker.
const PLACEHOLDER_ASPECT_RATIO = '1 / 1';

interface ReservedAspectImageProps {
  readonly src: string;
  readonly alt: string;
  readonly className?: string;
  readonly imageClassName?: string;
  readonly onLoadError?: () => void;
}

/**
 * Renders an image inside a container whose aspect ratio is reserved from the
 * moment it mounts. While the image is still loading we paint a neutral
 * skeleton; once the image reports its natural dimensions we lock the
 * container to that ratio and fade the image in.
 *
 * This eliminates the single, asynchronous "row jump" that the chat
 * virtualizer previously measured whenever an image finished loading, which
 * was the root cause of the intermittent scroll-to-bottom flicker.
 */
export function ReservedAspectImage({
  src,
  alt,
  className,
  imageClassName,
  onLoadError,
}: ReservedAspectImageProps) {
  const [naturalAspectRatio, setNaturalAspectRatio] = useState<string | null>(null);

  const handleLoad = (event: SyntheticEvent<HTMLImageElement>) => {
    const { naturalWidth, naturalHeight } = event.currentTarget;
    if (naturalWidth > 0 && naturalHeight > 0) {
      setNaturalAspectRatio(`${naturalWidth} / ${naturalHeight}`);
    }
  };

  return (
    <div
      className={`relative overflow-hidden ${className ?? ''}`}
      style={{ aspectRatio: naturalAspectRatio ?? PLACEHOLDER_ASPECT_RATIO }}
    >
      <img
        src={src}
        alt={alt}
        className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-300 ${
          naturalAspectRatio ? 'opacity-100' : 'opacity-0'
        } ${imageClassName ?? ''}`}
        decoding="async"
        onLoad={handleLoad}
        onError={onLoadError}
      />
      {!naturalAspectRatio && (
        <div
          aria-hidden
          className="absolute inset-0 animate-pulse bg-surface-container-highest/40"
        />
      )}
    </div>
  );
}
