/**
 * Driving a `Select` from a test.
 *
 * The settings forms used to hold native `<select>`s, which a test poked with
 * `user.selectOptions` or a `change` event carrying the new value. `Select` is
 * a listbox the app draws itself, so choosing is two clicks — the trigger, then
 * the row — and every migrated test would otherwise carry its own copy of that
 * pair.
 *
 * Usage: await chooseOption('Compaction behavior', 'Never compact');
 */

import { fireEvent, screen, within } from '@testing-library/react';

/**
 * Opens the `Select` named `name` and clicks the option matching `option`.
 *
 * `name` is the trigger's accessible name — its `ariaLabel`, or the text of the
 * `<label htmlFor>` pointing at it. `option` matches the option's visible text.
 */
export async function chooseOption(name: string | RegExp, option: string | RegExp): Promise<void> {
  const trigger = await screen.findByRole('combobox', { name });
  fireEvent.click(trigger);

  const listbox = await screen.findByRole('listbox');
  fireEvent.click(within(listbox).getByRole('option', { name: option }));
}
