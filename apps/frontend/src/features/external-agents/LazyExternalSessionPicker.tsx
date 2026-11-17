import { createLazyOverlay } from '@/components/layout/LazyOverlay';

import type { ExternalSessionPickerProps } from './ExternalSessionPicker';

/**
 * The native-session picker, fetched when "Browse sessions" is chosen in the
 * runner menu instead of with every page.
 *
 * Usage: `<lazyExternalSessionPicker.Overlay {...props} onLoadFailed={close} />`
 */
export const lazyExternalSessionPicker = createLazyOverlay<ExternalSessionPickerProps>(() =>
  import('./ExternalSessionPicker').then((module) => ({ default: module.ExternalSessionPicker }))
);
