/**
 * ToolAvatar and the rename dialog.
 *
 * A monogram is user content, so the two things worth pinning are that it is
 * rendered as text and that the dialog previews exactly what will be saved —
 * defaults included, because an empty field means "use the default" rather than
 * "store nothing". An image adds a third: it can fail to load at any time, and
 * a tool that vanishes from a list when its avatar 404s is worse than one
 * wearing its initials.
 */

import { en } from '@mangostudio/shared/i18n';
import { fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ToolAvatar } from '../../../../src/components/ui/ToolAvatar';
import { toolAvatarPalette } from '../../../../src/components/ui/tool-avatar-palette';
import { IdentityEditDialog } from '../../../../src/features/environments/identity/IdentityEditDialog';
import { toolImageDisplay } from '../../../../src/features/environments/identity/image';
import type { ResolvedToolIdentity } from '../../../../src/features/environments/identity/resolve';
import { render, screen } from '../../../support/harness/render';

const claudeIdentity: ResolvedToolIdentity = {
  subjectKey: 'agent:claude',
  name: 'Claude Code',
  monogram: 'CC',
  image: null,
  storedName: null,
  storedMonogram: null,
  storedImage: null,
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

  it('tells a third-party host nothing it does not have to', () => {
    render(
      <ToolAvatar
        subjectKey="agent:claude"
        monogram="CC"
        name="Claude Code"
        image={{ src: 'https://cdn.example.com/logo.png', remote: true }}
      />
    );

    const image = screen.getByTitle('Claude Code').querySelector('img');
    expect(image).toHaveAttribute('src', 'https://cdn.example.com/logo.png');
    // No referrer: the remote host learns that someone fetched the image, and
    // nothing about which page did.
    expect(image).toHaveAttribute('referrerpolicy', 'no-referrer');
    // And no `crossorigin`, which would demand a CORS header that ordinary
    // image hosts do not send — the load would fail and the avatar would show
    // its monogram instead of the picture the user asked for.
    expect(image).not.toHaveAttribute('crossorigin');
  });

  it('sends the session with an image our own API is holding', () => {
    render(
      <ToolAvatar
        subjectKey="agent:claude"
        monogram="CC"
        name="Claude Code"
        image={{ src: '/api/tool-identities/agent:claude/image?v=7', remote: false }}
      />
    );

    const image = screen.getByTitle('Claude Code').querySelector('img');
    // Stored images sit behind auth, so the request has to carry credentials
    // even when the API is on another origin.
    expect(image).toHaveAttribute('crossorigin', 'use-credentials');
    expect(image).not.toHaveAttribute('referrerpolicy');
  });

  it('falls back to the monogram when the image fails to load', () => {
    render(
      <ToolAvatar
        subjectKey="agent:claude"
        monogram="CC"
        name="Claude Code"
        image={{ src: 'https://cdn.example.com/gone.png', remote: true }}
      />
    );

    const avatar = screen.getByTitle('Claude Code');
    const image = avatar.querySelector('img');
    expect(image).not.toBeNull();

    // A hotlink can rot, 404, or be refused by a host that does not allow
    // cross-origin embedding. None of that should leave a hole in the list.
    if (image) fireEvent.error(image);

    expect(avatar.querySelector('img')).toBeNull();
    expect(avatar).toHaveTextContent('CC');
  });
});

describe('toolImageDisplay', () => {
  it('serves a cached image from our API with the identity as the cache-buster', () => {
    const display = toolImageDisplay(
      'agent:claude',
      { source: 'url', url: 'https://cdn.example.com/logo.png', cached: true },
      1234
    );

    // The address never changes when the image does, so without `v` a browser
    // would hold the replaced copy indefinitely.
    expect(display?.src).toContain('/api/tool-identities/agent:claude/image?v=1234');
    expect(display?.remote).toBe(false);
  });

  it('hotlinks an uncached image straight from the address the user gave', () => {
    const display = toolImageDisplay(
      'agent:claude',
      { source: 'url', url: 'https://cdn.example.com/logo.png', cached: false },
      1234
    );

    expect(display).toEqual({ src: 'https://cdn.example.com/logo.png', remote: true });
  });

  it('draws the monogram when there is no image', () => {
    expect(toolImageDisplay('agent:claude', null, 0)).toBeNull();
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
        identity={{
          ...claudeIdentity,
          name: 'Renamed',
          monogram: 'RE',
          storedName: 'Renamed',
          customized: true,
        }}
        defaultName="Claude Code"
        onClose={vi.fn()}
      />
    );

    await user.clear(screen.getByLabelText(en.environments.identity.nameLabel));

    expect(screen.getByTitle('Claude Code')).toHaveTextContent('CC');
  });

  it('keeps a stored monogram that happens to match the derived one', async () => {
    const user = userEvent.setup();
    render(
      <IdentityEditDialog
        identity={{ ...claudeIdentity, storedMonogram: 'CC', customized: true }}
        defaultName="Claude Code"
        onClose={vi.fn()}
      />
    );

    // "CC" is both what the user saved and what "Claude Code" derives to.
    // Seeding the field from the resolved value could not tell those apart, and
    // renaming would then submit `monogram: null` and drop the saved one.
    expect(screen.getByLabelText(en.environments.identity.monogramLabel)).toHaveValue('CC');

    await user.type(screen.getByLabelText(en.environments.identity.nameLabel), 'My Agent');

    expect(screen.getByTitle('My Agent')).toHaveTextContent('CC');
  });

  it('is a labelled modal that closes on Escape', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <IdentityEditDialog identity={claudeIdentity} defaultName="Claude Code" onClose={onClose} />
    );

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName(/Claude Code/);
    expect(screen.getByLabelText(en.environments.identity.nameLabel)).toHaveFocus();

    await user.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalled();
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

  it('starts on the monogram, and offers caching first when an address is chosen', async () => {
    const user = userEvent.setup();
    render(
      <IdentityEditDialog identity={claudeIdentity} defaultName="Claude Code" onClose={vi.fn()} />
    );

    const labels = en.environments.identity;
    expect(screen.getByRole('radio', { name: labels.imageModeNone })).toBeChecked();

    await user.click(screen.getByRole('radio', { name: labels.imageModeUrl }));

    // Caching is the option that keeps the remote host out of the picture, so
    // a user who does nothing else ends up with it.
    expect(screen.getByRole('checkbox', { name: labels.imageCacheLabel })).toBeChecked();
    expect(screen.getByTestId('tool-image-url-notice')).toHaveTextContent(
      labels.imageCacheOnNotice
    );
  });

  it('spells out what a hotlinked image costs the moment caching is turned off', async () => {
    const user = userEvent.setup();
    render(
      <IdentityEditDialog identity={claudeIdentity} defaultName="Claude Code" onClose={vi.fn()} />
    );

    const labels = en.environments.identity;
    await user.click(screen.getByRole('radio', { name: labels.imageModeUrl }));
    await user.click(screen.getByRole('checkbox', { name: labels.imageCacheLabel }));

    const notice = screen.getByTestId('tool-image-url-notice');
    expect(notice).toHaveTextContent(labels.imageCacheOffNotice);
    // The consequences the owner asked to be named, not a generic caution.
    expect(notice).toHaveTextContent(/IP address/);
    expect(notice).toHaveTextContent(/change the image after you save it/);
  });

  it('refuses to save an address that is not https', async () => {
    const user = userEvent.setup();
    render(
      <IdentityEditDialog identity={claudeIdentity} defaultName="Claude Code" onClose={vi.fn()} />
    );

    const labels = en.environments.identity;
    await user.click(screen.getByRole('radio', { name: labels.imageModeUrl }));
    await user.type(screen.getByLabelText(labels.imageUrlLabel), 'http://cdn.example.com/logo.png');

    expect(screen.getByText(labels.imageUrlInvalid)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: labels.save })).toBeDisabled();
  });

  it('previews a valid address on the avatar itself', async () => {
    const user = userEvent.setup();
    render(
      <IdentityEditDialog identity={claudeIdentity} defaultName="Claude Code" onClose={vi.fn()} />
    );

    const labels = en.environments.identity;
    await user.click(screen.getByRole('radio', { name: labels.imageModeUrl }));
    await user.type(
      screen.getByLabelText(labels.imageUrlLabel),
      'https://cdn.example.com/logo.png'
    );

    // Hotlinks fail for reasons the user cannot see coming — a host that
    // refuses cross-origin embedding, for one — so the preview is where they
    // find out, rather than on the card afterwards.
    const preview = screen.getByTitle('Claude Code').querySelector('img');
    expect(preview).toHaveAttribute('src', 'https://cdn.example.com/logo.png');
  });

  it('will not upload nothing when the upload mode is picked', async () => {
    const user = userEvent.setup();
    render(
      <IdentityEditDialog identity={claudeIdentity} defaultName="Claude Code" onClose={vi.fn()} />
    );

    const labels = en.environments.identity;
    await user.click(screen.getByRole('radio', { name: labels.imageModeUpload }));

    expect(screen.getByRole('button', { name: labels.save })).toBeDisabled();
    // Uploading is the user asserting a right they hold, so the dialog says so
    // before the file picker opens rather than after the fact.
    expect(screen.getByText(labels.imageRightsNotice)).toBeInTheDocument();
  });

  it('opens on the image the tool already has', () => {
    render(
      <IdentityEditDialog
        identity={{
          ...claudeIdentity,
          image: { src: 'https://cdn.example.com/logo.png', remote: true },
          storedImage: { source: 'url', url: 'https://cdn.example.com/logo.png', cached: false },
          customized: true,
        }}
        defaultName="Claude Code"
        onClose={vi.fn()}
      />
    );

    const labels = en.environments.identity;
    expect(screen.getByRole('radio', { name: labels.imageModeUrl })).toBeChecked();
    expect(screen.getByLabelText(labels.imageUrlLabel)).toHaveValue(
      'https://cdn.example.com/logo.png'
    );
    // Reopening must not silently re-enable caching on an image the user
    // deliberately left hotlinked.
    expect(screen.getByRole('checkbox', { name: labels.imageCacheLabel })).not.toBeChecked();
  });
});
