/**
 * The still half of the motion vocabulary is the half no component test can
 * reach: the `motion/react` stub pins `useReducedMotion()` to `true`, so a
 * rendered component only ever exercises one branch. These assertions are
 * where the other one is checked — and where "reduced motion actually means no
 * movement" stops being a claim in a comment.
 */

import { describe, expect, it } from 'bun:test';
import { DURATION_BASE, DURATION_QUICK, EASE_STANDARD } from '@/lib/motion/tokens';
import { CARD_ENTER, CARD_REST, motionPresets, staggerBy } from '@/lib/motion/variants';

const MOVING = motionPresets(false);
const STILL = motionPresets(true);

/** Every preset that is a plain `initial`/`animate`/`exit` triple. */
const TRIPLE_PRESETS = [
  'overlay',
  'dialogPanel',
  'popoverBelow',
  'popoverAbove',
  'collapse',
  'fade',
  'fadeRise',
] as const;

/** Properties that move a box around the screen, as opposed to fading it. */
const MOVEMENT_KEYS = ['y', 'x', 'scale'] as const;

describe('motionPresets', () => {
  it('returns a stable reference per preference, so props do not churn', () => {
    expect(motionPresets(false)).toBe(MOVING);
    expect(motionPresets(true)).toBe(STILL);
    expect(MOVING).not.toBe(STILL);
  });

  // A plain loop rather than `describe.each`: that helper widens the preset
  // name to `any`, which would silently stop these from checking anything.
  for (const name of TRIPLE_PRESETS) {
    describe(name, () => {
      it('animates to a resting state with no offset left applied', () => {
        const { animate } = MOVING[name];
        expect(animate).toHaveProperty('opacity', 1);
        for (const key of MOVEMENT_KEYS) {
          if (!(key in animate)) continue;
          expect(animate[key as keyof typeof animate]).toBe(key === 'scale' ? 1 : 0);
        }
      });

      it('takes no time at all when motion is reduced', () => {
        expect(STILL[name].transition.duration).toBe(0);
        expect(MOVING[name].transition.duration).toBeGreaterThan(0);
      });

      it('does not move when motion is reduced', () => {
        const { initial, exit } = STILL[name];
        for (const target of [initial, exit]) {
          for (const key of MOVEMENT_KEYS) {
            if (!(key in target)) continue;
            // A scale of 1 and a translate of 0 are both "already in place".
            expect(target[key as keyof typeof target]).toBe(key === 'scale' ? 1 : 0);
          }
        }
      });

      it('still fades, so presence remains legible when motion is reduced', () => {
        expect(STILL[name].initial).toHaveProperty('opacity', 0);
        expect(STILL[name].animate).toHaveProperty('opacity', 1);
      });
    });
  }

  it('opens panels away from their trigger in the direction they are anchored', () => {
    // Anchored below its trigger, the panel drops in: it starts above where it
    // lands. Anchored above (the composer's selectors), it rises into place.
    expect(MOVING.popoverBelow.initial.y).toBeLessThan(0);
    expect(MOVING.popoverAbove.initial.y).toBeGreaterThan(0);
  });

  it('uses the quick token for panels and the base token for content', () => {
    expect(MOVING.popoverAbove.transition.duration).toBe(DURATION_QUICK);
    expect(MOVING.popoverBelow.transition.duration).toBe(DURATION_QUICK);
    expect(MOVING.overlay.transition.duration).toBe(DURATION_QUICK);
    expect(MOVING.collapse.transition.duration).toBe(DURATION_BASE);
    expect(MOVING.dialogPanel.transition.duration).toBe(DURATION_BASE);
  });

  it('eases everything the same way', () => {
    for (const name of TRIPLE_PRESETS) {
      expect(MOVING[name].transition.ease).toBe(EASE_STANDARD);
    }
  });

  it('keeps collapse driven by height, so a virtualized row can be measured', () => {
    // A transform would look identical and leave every row below it overlapping,
    // because the virtualizer sizes a row from its measured height.
    expect(MOVING.collapse.animate.height).toBe('auto');
    expect(MOVING.collapse.initial.height).toBe(0);
    // Reduced motion must still open the disclosure — instantly, not never.
    expect(STILL.collapse.animate.height).toBe('auto');
    expect(STILL.collapse.transition.duration).toBe(0);
  });
});

describe('card grid variants', () => {
  it('staggers children when motion is allowed', () => {
    const delay = MOVING.cardGrid.variants[CARD_ENTER].transition.delayChildren;
    expect(typeof delay).toBe('function');
  });

  it('drops the stagger to a flat zero when motion is reduced', () => {
    expect(STILL.cardGrid.variants[CARD_ENTER].transition.delayChildren).toBe(0);
  });

  it('drives its own variants through initial/animate, so a consumer only spreads it', () => {
    expect(MOVING.cardGrid.initial).toBe(CARD_REST);
    expect(MOVING.cardGrid.animate).toBe(CARD_ENTER);
  });

  it('names its labels distinctly, so an unrelated ancestor cannot drive it', () => {
    // `motion` propagates variant labels through React context. Generic
    // `hidden`/`visible` names would make every card animate whenever any
    // ancestor drove a variant of that name.
    expect(CARD_REST).not.toBe('hidden');
    expect(CARD_ENTER).not.toBe('visible');
    expect(Object.keys(MOVING.cardItem).sort()).toEqual([CARD_ENTER, CARD_REST].sort());
  });

  it('rests a card offset and enters it in place', () => {
    expect(MOVING.cardItem[CARD_REST].y).toBeGreaterThan(0);
    expect(MOVING.cardItem[CARD_ENTER].y).toBe(0);
    expect(STILL.cardItem[CARD_REST].y).toBe(0);
  });
});

describe('staggerBy', () => {
  it('delays each child by one more step than the last', () => {
    const delay = staggerBy(0.04);
    expect(delay(0)).toBe(0);
    expect(delay(1)).toBeCloseTo(0.04);
    expect(delay(5)).toBeCloseTo(0.2);
  });

  it('leaves the first child undelayed, so the grid starts immediately', () => {
    expect(staggerBy(1)(0)).toBe(0);
  });
});
