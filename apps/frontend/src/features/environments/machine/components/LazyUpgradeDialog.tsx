import { createLazyOverlay } from '@/components/layout/LazyOverlay';

import type { UpgradeDialogProps } from './UpgradeDialog';

/**
 * The machine upgrade dialog and its progress stream, fetched when someone
 * presses Upgrade on the banner instead of with every page.
 *
 * Usage: `<lazyUpgradeDialog.Overlay status={status} onClose={close} onLoadFailed={close} />`
 */
export const lazyUpgradeDialog = createLazyOverlay<UpgradeDialogProps>(() =>
  import('./UpgradeDialog').then((module) => ({ default: module.UpgradeDialog }))
);
