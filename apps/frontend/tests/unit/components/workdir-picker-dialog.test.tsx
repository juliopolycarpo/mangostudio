import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';
import userEvent from '@testing-library/user-event';
import { WorkdirPickerDialog } from '../../../src/features/workspace/WorkdirPickerDialog';
import {
  act,
  fireEvent,
  flushAsyncRender,
  render,
  screen,
  waitFor,
} from '../../support/harness/render';

/**
 * Lets the last browse request the dialog fired finish inside `act`.
 *
 * Every interaction below starts a query, and the final one resolves after the
 * test body ends — which leaves its state update outside `act` and prints an
 * "update was not wrapped in act(...)" block on a green test.
 */
const settlePendingBrowse = flushAsyncRender;

import { createFetchScenario } from '../../support/mocks/create-fetch-scenario';

describe('WorkdirPickerDialog', () => {
  const fetchScenario = createFetchScenario();

  beforeEach(() => {
    window.localStorage.setItem('mangostudio:locale', 'en');
    fetchScenario.install();
  });

  afterEach(() => {
    fetchScenario.restore();
    window.localStorage.clear();
  });

  it('navigates server folders, reveals hidden entries, and selects the current path', async () => {
    const user = userEvent.setup();
    const onSelect = jest.fn();
    fetchScenario.respondWithJson(
      'GET',
      '/api/workspace/fs?path=%2Fsrv%2Fprojects&chatId=chat-remote',
      {
        body: {
          path: '/srv/projects',
          parent: '/srv',
          entries: [
            { name: '.private', path: '/srv/projects/.private', hidden: true },
            { name: 'mangostudio', path: '/srv/projects/mangostudio', hidden: false },
          ],
          home: '/home/mango',
          roots: ['/'],
          separator: '/',
        },
      }
    );
    fetchScenario.respondWithJson(
      'GET',
      '/api/workspace/fs?path=%2Fsrv%2Fprojects%2Fmangostudio&chatId=chat-remote',
      {
        body: {
          path: '/srv/projects/mangostudio',
          parent: '/srv/projects',
          entries: [],
          home: '/home/mango',
          roots: ['/'],
          separator: '/',
        },
      }
    );

    render(
      <WorkdirPickerDialog
        open
        chatId="chat-remote"
        initialPath="/srv/projects"
        recentWorkdirs={['/srv/other']}
        onSelect={onSelect}
        onClose={jest.fn()}
      />
    );
    await settlePendingBrowse();

    expect(
      screen.getByText(/Agent file tools resolve relative paths from this folder/)
    ).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'mangostudio' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '.private' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Show hidden' }));
    expect(screen.getByRole('button', { name: '.private' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'mangostudio' }));
    // The "Server path" field is where the current folder is written: entering
    // a folder fills it in, so there is no second, read-only copy of the path.
    await waitFor(() =>
      expect(screen.getByLabelText('Server path')).toHaveValue('/srv/projects/mangostudio')
    );
    await user.click(screen.getByRole('button', { name: 'Select this folder' }));

    expect(onSelect).toHaveBeenCalledWith('/srv/projects/mangostudio');

    await settlePendingBrowse();
  });

  // A directory listing is a stack of rows with a hover wash, like the rail
  // beside it, and not a grid of bordered secondary buttons. A recent folder
  // leads with its name, so three siblings under /tmp can be told apart.
  it('draws folders as plain rows and names a recent folder before its parent', async () => {
    fetchScenario.respondWithJson('GET', '/api/workspace/fs?path=%2Fsrv%2Fprojects', {
      body: {
        path: '/srv/projects',
        parent: '/srv',
        entries: [{ name: 'mangostudio', path: '/srv/projects/mangostudio', hidden: false }],
        home: '/home/mango',
        roots: ['/'],
        separator: '/',
      },
    });

    render(
      <WorkdirPickerDialog
        open
        initialPath="/srv/projects"
        recentWorkdirs={['/tmp/mangostudio-visual-1', '/tmp/mangostudio-visual-2']}
        onSelect={jest.fn()}
        onClose={jest.fn()}
      />
    );
    await settlePendingBrowse();

    const folder = await screen.findByRole('button', { name: 'mangostudio' });
    expect(folder).not.toHaveClass('border');
    expect(folder).toHaveClass('hover:bg-fill-hover');

    const recent = screen.getByRole('button', { name: /mangostudio-visual-2/ });
    expect(recent).toHaveAttribute('title', '/tmp/mangostudio-visual-2');
    expect(recent.textContent).toBe('mangostudio-visual-2/tmp');

    await settlePendingBrowse();
  });

  it('validates a manually entered server path before browsing it', async () => {
    const user = userEvent.setup();
    fetchScenario
      .respondWithJson('GET', '/api/workspace/fs?chatId=chat-remote', {
        body: {
          path: '/home/mango',
          parent: '/home',
          entries: [],
          home: '/home/mango',
          roots: ['/'],
          separator: '/',
        },
      })
      .respondWithJson('POST', '/api/workspace/fs/validate', {
        body: { ok: true, resolvedPath: '/srv/manual' },
      })
      .respondWithJson('GET', '/api/workspace/fs?path=%2Fsrv%2Fmanual&chatId=chat-remote', {
        body: {
          path: '/srv/manual',
          parent: '/srv',
          entries: [],
          home: '/home/mango',
          roots: ['/'],
          separator: '/',
        },
      });

    render(
      <WorkdirPickerDialog open chatId="chat-remote" onSelect={jest.fn()} onClose={jest.fn()} />
    );
    await settlePendingBrowse();

    const pathInput = await screen.findByLabelText('Server path');
    await waitFor(() => expect(pathInput).toHaveValue('/home/mango'));
    await settlePendingBrowse();
    await user.clear(pathInput);
    await user.type(pathInput, '/srv/manual');
    // `handleManualBrowse` is async, so its `setIsValidating(false)` and the
    // browse it starts land after `user.click` has already resolved — outside
    // the `act` userEvent puts around the click itself. `fireEvent.submit`
    // drives the same handler without userEvent's own act bracket, so the one
    // below covers the whole continuation.
    await act(async () => {
      fireEvent.submit(
        screen.getByRole('button', { name: 'Open' }).closest('form') as HTMLFormElement
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await waitFor(() =>
      expect(fetchScenario.fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/api/workspace/fs?path=%2Fsrv%2Fmanual'),
        expect.anything()
      )
    );
    expect(fetchScenario.fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/workspace/fs/validate'),
      expect.objectContaining({
        body: JSON.stringify({ path: '/srv/manual', chatId: 'chat-remote' }),
        method: 'POST',
      })
    );

    await settlePendingBrowse();
  });

  /**
   * Every caller keeps this component mounted and toggles `open` rather than
   * mounting it fresh — the palette opens it while its own overlay is still
   * animating out. A focus trap keyed only on `onClose` would have run its
   * effect once against the still-absent dialog and never again, so the
   * picker would sit open with focus left on whatever was behind it.
   */
  it('takes focus when it opens after being mounted closed', async () => {
    fetchScenario.respondWithJson('GET', '/api/workspace/fs', {
      body: {
        path: '/home/mango',
        parent: '/home',
        entries: [],
        home: '/home/mango',
        roots: ['/'],
        separator: '/',
      },
    });

    const trigger = document.createElement('button');
    document.body.append(trigger);
    trigger.focus();

    const { rerender } = render(
      <WorkdirPickerDialog open={false} onSelect={jest.fn()} onClose={jest.fn()} />
    );
    expect(document.activeElement).toBe(trigger);

    act(() => {
      rerender(<WorkdirPickerDialog open onSelect={jest.fn()} onClose={jest.fn()} />);
    });
    await settlePendingBrowse();

    expect(document.activeElement).toBe(screen.getByRole('dialog'));
    trigger.remove();
  });

  it('closes on Escape once opened this way, and keeps Tab inside it', async () => {
    fetchScenario.respondWithJson('GET', '/api/workspace/fs', {
      body: {
        path: '/home/mango',
        parent: '/home',
        entries: [],
        home: '/home/mango',
        roots: ['/'],
        separator: '/',
      },
    });

    const onClose = jest.fn();
    const { rerender } = render(
      <WorkdirPickerDialog open={false} onSelect={jest.fn()} onClose={onClose} />
    );
    act(() => {
      rerender(<WorkdirPickerDialog open onSelect={jest.fn()} onClose={onClose} />);
    });
    await settlePendingBrowse();

    // The ring wraps rather than walking out: back from the first stop lands on
    // the dialog's own last control, not on the page behind it. The dialog fills
    // the viewport, so anything Tab reaches out there is unreachable by mouse.
    const dialog = screen.getByRole('dialog');
    const close = screen.getByRole('button', { name: 'Close' });
    close.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(close);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
