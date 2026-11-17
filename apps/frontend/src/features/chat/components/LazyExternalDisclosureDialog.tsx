import { createLazyOverlay } from '@/components/layout/LazyOverlay';

import type { ExternalDisclosureDialogProps } from './ExternalDisclosureDialog';

/**
 * The third-party notice, fetched when a vendor's first use asks for it rather
 * than with the entry chunk. Two surfaces open it (the runner selector and the
 * send-time gate), so they share one binding and one chunk.
 *
 * Usage: `<lazyExternalDisclosureDialog.Overlay {...props} onLoadFailed={dismiss} />`
 */
export const lazyExternalDisclosureDialog = createLazyOverlay<ExternalDisclosureDialogProps>(() =>
  import('./ExternalDisclosureDialog').then((module) => ({
    default: module.ExternalDisclosureDialog,
  }))
);
