/**
 * The permission control renders the combinations the adapter vetted, and only
 * those. Two free controls composing a pair no vendor offers is the failure this
 * shape exists to prevent, so the tests are written against that.
 */

import { describe, expect, it, jest } from 'bun:test';
import type { ExternalSupportedConfiguration } from '@mangostudio/shared/external-agents';
import { fireEvent, screen } from '@testing-library/react';
import { PermissionSelector } from '../../../src/features/chat/components/PermissionSelector';
import { render } from '../../support/harness/render';

function open(
  configurations: readonly ExternalSupportedConfiguration[],
  overrides: Partial<React.ComponentProps<typeof PermissionSelector>> = {}
) {
  const props = {
    configurations,
    level: 'default' as const,
    routing: 'user' as const,
    targetId: 'claude' as const,
    onChange: jest.fn(),
    ...overrides,
  };
  const result = render(<PermissionSelector {...props} />);
  fireEvent.click(screen.getByRole('button', { name: /permissions/i }));
  return { ...result, props };
}

/**
 * The panel with the two axes revealed.
 *
 * Presets are what the panel opens on now, so a test about the matrix has to
 * say so. Expanding here rather than weakening the assertions keeps these tests
 * about what they were always about — that two free controls can never compose
 * a pair no vendor offers.
 */
function openMatrix(
  configurations: readonly ExternalSupportedConfiguration[],
  overrides: Partial<React.ComponentProps<typeof PermissionSelector>> = {}
) {
  const opened = open(configurations, overrides);
  const advanced = screen.queryByRole('button', { name: /Fine-tune/ });
  if (advanced) fireEvent.click(advanced);
  return opened;
}

const FULL_MATRIX: ExternalSupportedConfiguration[] = [
  { level: 'read-only', routing: 'user', supported: true, unattended: false },
  { level: 'default', routing: 'user', supported: true, unattended: false },
  { level: 'full-access', routing: 'user', supported: true, unattended: true },
  { level: 'default', routing: 'auto-review', supported: true, unattended: true },
];

describe('permission selector', () => {
  it('renders only the levels and routings the adapter returned', () => {
    openMatrix([
      { level: 'read-only', routing: 'user', supported: true, unattended: false },
      { level: 'default', routing: 'user', supported: true, unattended: false },
    ]);
    expect(screen.getByRole('button', { name: /Read only/ })).toBeInTheDocument();
    // `full-access` appears in no returned pair, so it is not a choice this
    // vendor has, so it is not a control.
    expect(screen.queryByRole('button', { name: /Allow everything/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Auto-review/ })).toBeNull();
  });

  it('renders nothing at all when the adapter returned no combinations', () => {
    render(
      <PermissionSelector
        configurations={[]}
        level="read-only"
        routing="user"
        targetId="claude"
        onChange={jest.fn()}
      />
    );
    expect(screen.queryByRole('button', { name: /permissions/i })).toBeNull();
  });

  it('disables an unsupported pair and shows it as a policy refusal', () => {
    openMatrix([
      { level: 'default', routing: 'user', supported: true, unattended: false },
      {
        level: 'full-access',
        routing: 'user',
        supported: false,
        unattended: true,
        unsupportedReasonKey: 'externalAgents.unsupported.codexProfileDisallowed',
      },
    ]);
    const fullAccess = screen.getByRole('button', { name: /Allow everything/ });
    expect(fullAccess).toBeDisabled();
    // The user is looking at something their machine's config decided, not at a
    // MangoStudio limitation.
    expect(screen.getByText(/does not allow that profile/i)).toBeInTheDocument();
  });

  it('falls back to a generic refusal for a reason key it does not know', () => {
    openMatrix([
      { level: 'default', routing: 'user', supported: true, unattended: false },
      {
        level: 'full-access',
        routing: 'user',
        supported: false,
        unattended: true,
        unsupportedReasonKey: 'externalAgents.unsupported.somethingNewer',
      },
    ]);
    expect(screen.getByText(/does not offer this combination/i)).toBeInTheDocument();
  });

  it('warns on full access and on auto-review, and nowhere else', () => {
    openMatrix(FULL_MATRIX);
    expect(screen.getByText(/answered without you/i)).toBeInTheDocument();
    // Twice, and both are wanted: the `Autonomous` preset resolves to an
    // unattended pair, so it carries the same warning the axis row does.
    // Understating it in the control most people will actually use is the one
    // place in this UI where softening the language is dangerous.
    expect(screen.queryAllByText(/can edit and run anything/i)).toHaveLength(2);
    // Still nowhere near the levels that do stop and ask.
    expect(screen.queryAllByText(/can edit and run anything/i).length).toBeLessThan(
      screen.getAllByRole('button').length
    );
  });

  it('writes the risk as a sentence, once, and names the group for the chip it hangs from', () => {
    open(FULL_MATRIX);
    // Sentence case with its full stop, like every other line in the panel — the
    // one line about risk is not the one written like a fragment.
    for (const warning of screen.getAllByText('This agent can edit and run anything.')) {
      expect(warning).toHaveClass('text-fg');
    }
    // The group heading is the chip's own key (`mode:`), a noun, not a question.
    expect(screen.getByText('Mode')).toBeInTheDocument();
    expect(screen.queryByText(/how much should it bother you/i)).toBeNull();
    // The risk is the warning's to carry: the preset's own line does not say
    // "without stopping to ask" a second time.
    expect(
      screen.getByText(/^Keeps going on its own\. Claude acts without asking/)
    ).toBeInTheDocument();
  });

  it('moves the other axis to something composable rather than to an unsupported pair', () => {
    const { props } = openMatrix([
      { level: 'read-only', routing: 'user', supported: true, unattended: false },
      { level: 'full-access', routing: 'auto-review', supported: true, unattended: true },
      { level: 'full-access', routing: 'user', supported: false, unattended: true },
    ]);
    fireEvent.click(screen.getByRole('button', { name: /Allow everything/ }));
    expect(props.onChange).toHaveBeenCalledWith({
      level: 'full-access',
      routing: 'auto-review',
    });
  });

  it('marks the pair the chat is actually on', () => {
    openMatrix(FULL_MATRIX, { level: 'full-access', routing: 'user' });
    expect(screen.getByRole('button', { name: /Allow everything/ })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(screen.getByRole('button', { name: /Read only/ })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
  });
});

/**
 * Presets are the control a non-expert actually uses; the matrix underneath is
 * for everyone else. What is tested here is that a preset never offers a pair
 * the vendor cannot run, and that picking one writes the same thing the matrix
 * would have.
 */
describe('permission presets', () => {
  it('offers a named choice instead of two axes', () => {
    open(FULL_MATRIX, { targetId: 'claude' });

    expect(screen.getByRole('button', { name: /Careful/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Balanced/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Autonomous/ })).toBeInTheDocument();
    // The matrix is still there, behind a disclosure rather than removed.
    expect(screen.queryByText('What it can do')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Fine-tune/ }));
    expect(screen.getByText('What it can do')).toBeInTheDocument();
  });

  it('writes the pair the matrix would have written', () => {
    const { props } = open(FULL_MATRIX, { targetId: 'claude' });

    fireEvent.click(screen.getByRole('button', { name: /Careful/ }));

    expect(props.onChange).toHaveBeenCalledWith({ level: 'read-only', routing: 'user' });
  });

  /**
   * A preset with no supported candidate is not offered at all. A control that
   * cannot work is worse than one that is not there — it reads as a MangoStudio
   * fault rather than as something this vendor does not do.
   */
  it('hides a preset this vendor supports no pair for', () => {
    open(
      [
        { level: 'default', routing: 'user', supported: true, unattended: false },
        { level: 'full-access', routing: 'user', supported: false, unattended: true },
      ],
      { targetId: 'claude' }
    );

    expect(screen.getByRole('button', { name: /Balanced/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Autonomous/ })).toBeNull();
  });

  /**
   * The same preset is a different pair on different vendors, so the fallback
   * candidate has to be reachable: Claude's `auto-review` is an account-gated
   * classifier, and a vendor offering only that must still get `Autonomous`.
   */
  it('falls back to the next candidate pair a vendor does support', () => {
    const { props } = open(
      [
        { level: 'default', routing: 'user', supported: true, unattended: false },
        { level: 'full-access', routing: 'user', supported: false, unattended: true },
        { level: 'default', routing: 'auto-review', supported: true, unattended: true },
      ],
      { targetId: 'claude' }
    );

    // The warning follows the axis the preset resolved to, not the preset. This
    // pair cannot leave the workspace, so the level warning would be false
    // here; what is true is that its approvals are answered without the user.
    expect(screen.getByText(/answered without you/i)).toBeInTheDocument();
    expect(screen.queryByText(/can edit and run anything/i)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Autonomous/ }));

    expect(props.onChange).toHaveBeenCalledWith({ level: 'default', routing: 'auto-review' });
  });

  /** A pair no preset names is a deliberate custom choice, so the matrix opens. */
  it('opens the matrix for a pair no preset covers', () => {
    open(
      [
        ...FULL_MATRIX,
        { level: 'read-only', routing: 'auto-review', supported: true, unattended: false },
      ],
      {
        targetId: 'claude',
        level: 'read-only',
        routing: 'auto-review',
      }
    );

    expect(screen.getByText('What it can do')).toBeInTheDocument();
  });

  it('says what the preset means for this vendor', () => {
    open(FULL_MATRIX, { targetId: 'codex' });

    expect(screen.getByText(/read-only sandbox/)).toBeInTheDocument();
  });

  /**
   * The same instance outlives the chat it was mounted for.
   *
   * The composer is not remounted when the active chat changes, so a matrix
   * opened only by `useState`'s initializer would stay closed for every custom
   * pair after the first render — three presets with none selected, and no way
   * to see what is actually set.
   */
  it('opens the matrix when a later pair turns out to be custom', () => {
    const configurations = [
      ...FULL_MATRIX,
      {
        level: 'read-only' as const,
        routing: 'auto-review' as const,
        supported: true,
        unattended: false,
      },
    ];
    const { rerender } = open(configurations, { level: 'default', routing: 'user' });
    expect(screen.queryByText('What it can do')).toBeNull();

    rerender(
      <PermissionSelector
        configurations={configurations}
        level="read-only"
        routing="auto-review"
        targetId="claude"
        onChange={jest.fn()}
      />
    );

    expect(screen.getByText('What it can do')).toBeInTheDocument();
  });
});

/**
 * The chip says the setting in the words of the list it opens. `Default` is the
 * level's name on an axis that only the fine-tune matrix shows; read next to a
 * checked `Balanced`, it looks like the pick did not take.
 */
describe('permission chip', () => {
  const chipFor = (props: Partial<React.ComponentProps<typeof PermissionSelector>>) => {
    render(
      <PermissionSelector
        configurations={FULL_MATRIX}
        level="default"
        routing="user"
        targetId="claude"
        onChange={jest.fn()}
        {...props}
      />
    );
    return screen.getByRole('button', { name: /permissions/i });
  };

  it('names the preset the popover offers and checks', () => {
    const chip = chipFor({});
    expect(chip).toHaveTextContent('Balanced');
    expect(chip).not.toHaveTextContent('Default');

    fireEvent.click(chip);
    expect(screen.getByRole('button', { name: /Balanced/, pressed: true })).toBeInTheDocument();
  });

  it('follows the preset to another pair', () => {
    expect(chipFor({ level: 'read-only' })).toHaveTextContent('Careful');
  });

  it('keeps the level name when the vendor does not offer the preset the pair matches', () => {
    // `default x user` matches Balanced, but this vendor only supports the
    // auto-review pair, so the popover has no Balanced row to match the chip.
    const chip = chipFor({
      configurations: [
        { level: 'default', routing: 'auto-review', supported: true, unattended: true },
      ],
    });
    expect(chip).toHaveTextContent('Default');
    expect(chip).not.toHaveTextContent('Balanced');
  });
});

/**
 * Every composer menu marks the chosen row the same way: a check in `accent-fg`
 * after the label, on a `fill-selected` row. This one drew a leading column
 * holding a check on the chosen row and a text glyph (`○`) on the others, which
 * is a font character rather than an icon and renders differently per platform.
 */
describe('permission selected mark', () => {
  it('marks the chosen row with a trailing check and gives the others no mark', () => {
    open(FULL_MATRIX, { targetId: 'claude', level: 'read-only', routing: 'user' });

    const chosen = screen.getByRole('button', { name: /Careful/ });
    expect(chosen).toHaveAttribute('aria-pressed', 'true');
    expect(chosen.className).toContain('bg-fill-selected');
    expect(chosen.lastElementChild?.getAttribute('class')).toContain('lucide-check');

    const other = screen.getByRole('button', { name: /Balanced/ });
    expect(other.querySelector('.lucide-check')).toBeNull();
    expect(document.body.textContent).not.toContain('○');
  });
});
