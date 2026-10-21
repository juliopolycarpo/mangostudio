import { useState } from 'react';
import { Skeleton } from '@/components/ui/Skeleton';
import { cn } from '@/lib/utils';

const DEFAULT_RESERVED_ASPECT_RATIO = '1 / 1';

interface ReservedAspectImageProps {
  readonly src: string;
  readonly alt: string;
  readonly aspectRatio?: string;
  readonly objectFit?: 'contain' | 'cover';
  readonly className?: string;
  readonly imageClassName?: string;
  readonly onLoadError?: () => void;
}

/**
 * Renders an image inside a container whose aspect ratio is reserved from the
 * moment it mounts. Image load only fades pixels in; it never changes row
 * height, which keeps virtualized chat rows stable.
 *
 * This avoids the asynchronous resize that previously made the chat
 * virtualizer recalculate row positions while scroll-to-bottom was active.
 */
export function ReservedAspectImage({
  src,
  alt,
  aspectRatio = DEFAULT_RESERVED_ASPECT_RATIO,
  objectFit = 'cover',
  className,
  imageClassName,
  onLoadError,
}: ReservedAspectImageProps) {
  const [isLoaded, setIsLoaded] = useState(false);
  const fitClassName = objectFit === 'contain' ? 'object-contain' : 'object-cover';

  return (
    <div className={cn('relative overflow-hidden', className)} style={{ aspectRatio }}>
      <img
        src={src}
        alt={alt}
        className={cn(
          'absolute inset-0 size-full transition-opacity duration-300',
          fitClassName,
          isLoaded ? 'opacity-100' : 'opacity-0',
          imageClassName
        )}
        decoding="async"
        onLoad={() => setIsLoaded(true)}
        onError={onLoadError}
      />
      {!isLoaded && <Skeleton className="absolute inset-0 rounded-none" />}
    </div>
  );
}
