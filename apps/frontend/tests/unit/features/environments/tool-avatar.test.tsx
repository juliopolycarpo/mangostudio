/**
 * ToolAvatar and the rename dialog.
 *
 * A monogram is user content, so the two things worth pinning are that it is
 * rendered as text and that the dialog previews exactly what will be saved —
 * defaults included, because an empty field means "use the default" rather than
 * "store nothing".
 */

import { en } from '@mangostudio/shared/i18n';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ToolAvatar } from '../../../../src/components/ui/ToolAvatar';
import { toolAvatarPalette } from '../../../../src/components/ui/tool-avatar-palette';
import { IdentityEditDialog } from '../../../../src/features/environments/identity/IdentityEditDialog';
import type { ResolvedToolIdentity } from '../../../../src/features/environments/identity/resolve';
import { render, screen } from '../../../support/harness/render';

const claudeIdentity: ResolvedToolIdentity = {
  subjectKey: 'agent:claude',
  name: 'Claude Code',
  monogram: 'CC',
  customized: false,
};

describe('ToolAvatar', () => {
  it('renders the monogram as text under the tool name', () => {
    render(<ToolAvatar subjectKey="agent:claude" monogram="CC" name="Claude Code" />);

    const avatar = screen.getByTitle('Claude Code');
    expect(avatar).toHaveTextContent('CC');
    expect(avatar).toHaveAttribute('data-palette-slot', toolAvatarPalette('agent:claude').slot);
  });

  it('never interprets a monogram as markup', () => {
    render(<ToolAvatar subjectKey="mcp:weather" monogram="<b" name="Weather" />);

    const avatar = screen.getByTitle('Weather');
    expect(avatar).toHaveTextContent('<b');
    expect(avatar.querySelector('b')).toBeNull();
  });

  it('carries both themes so the palette is not tied to the theme context', () => {
    render(<ToolAvatar subjectKey="runtime:bun" monogram="BU" name="Bun" />);

    const style = screen.getByTitle('Bun').getAttribute('style') ?? '';
    expect(style).toContain('--tool-avatar-bg-dark');
    expect(style).toContain('--tool-avatar-bg-light');
  });
});

describe('IdentityEditDialog', () => {
  it('previews the derived monogram as the name is typed', async () => {
    const user = userEvent.setup();
    render(
      <IdentityEditDialog identity={claudeIdentity} defaultName="Claude Code" onClose={vi.fn()} />
    );

    await user.type(screen.getByLabelText(en.environments.identity.nameLabel), 'My Agent');

    expect(screen.getByTitle('My Agent')).toHaveTextContent('MA');
  });

  it('falls back to the default name when the field is cleared', async () => {
    const user = userEvent.setup();
    render(
      <IdentityEditDialog
        identity={{ ...claudeIdentity, name: 'Renamed', monogram: 'RE', customized: true }}
        defaultName="Claude Code"
        onClose={vi.fn()}
      />
    );

    await user.clear(screen.getByLabelText(en.environments.identity.nameLabel));

    expect(screen.getByTitle('Claude Code')).toHaveTextContent('CC');
  });

  it('explains an unusable monogram instead of letting the request fail', async () => {
    const user = userEvent.setup();
    render(
      <IdentityEditDialog identity={claudeIdentity} defaultName="Claude Code" onClose={vi.fn()} />
    );

    await user.type(screen.getByLabelText(en.environments.identity.monogramLabel), '<>');

    expect(screen.getByText(en.environments.identity.monogramInvalid)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: en.environments.identity.save })).toBeDisabled();
  });
});
