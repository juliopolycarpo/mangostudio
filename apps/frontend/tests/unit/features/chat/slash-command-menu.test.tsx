/**
 * Regression for the palette's scroll-into-view effect: it must rerun when
 * `entries` changes even if `activeIndex` numerically stays the same — the
 * common case is index `0` with no arrow-key interaction, where a new query
 * can swap in a different top match under an untouched index.
 */

import { describe, expect, it, jest } from 'bun:test';
import { SlashCommandMenu } from '../../../../src/features/chat/components/SlashCommandMenu';
import type { SlashCommandEntry } from '../../../../src/features/chat/lib/slash-commands';
import { render } from '../../../support/harness/render';

const REVIEW: SlashCommandEntry = { name: 'review', origin: 'session' };
const DATAVIZ: SlashCommandEntry = { name: 'dataviz', origin: 'skill' };

const noop = jest.fn();

describe('SlashCommandMenu', () => {
  it('scrolls the active row into view when entries change under an untouched index', () => {
    const scrollIntoView = jest.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollIntoView;

    try {
      const { rerender } = render(
        <SlashCommandMenu
          entries={[REVIEW]}
          activeIndex={0}
          listId="slash-menu"
          onSelect={noop}
          onHighlight={noop}
        />
      );
      expect(scrollIntoView).toHaveBeenCalledTimes(1);

      // A new query narrows the list to a different top match, but the
      // highlight never moved off its default — `activeIndex` stays `0`.
      rerender(
        <SlashCommandMenu
          entries={[DATAVIZ]}
          activeIndex={0}
          listId="slash-menu"
          onSelect={noop}
          onHighlight={noop}
        />
      );

      expect(scrollIntoView).toHaveBeenCalledTimes(2);
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });
});
