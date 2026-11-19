import { createLazyOverlay } from '@/components/layout/LazyOverlay';

import type { WorkdirPickerDialogProps } from './WorkdirPickerDialog';

/**
 * The folder picker, fetched when the workdir chip is pressed instead of with
 * the chat page.
 *
 * Usage: `<lazyWorkdirPickerDialog.Overlay {...props} onLoadFailed={props.onClose} />`
 */
export const lazyWorkdirPickerDialog = createLazyOverlay<WorkdirPickerDialogProps>(() =>
  import('./WorkdirPickerDialog').then((module) => ({ default: module.WorkdirPickerDialog }))
);
