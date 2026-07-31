import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkdirPickerDialog } from '../../../src/features/workspace/WorkdirPickerDialog';
import { render, screen, waitFor } from '../../support/harness/render';
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
    const onSelect = vi.fn();
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
        onClose={vi.fn()}
      />
    );

    expect(
      screen.getByText(/Agent file tools resolve relative paths from this folder/)
    ).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'mangostudio' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '.private' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Show hidden' }));
    expect(screen.getByRole('button', { name: '.private' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'mangostudio' }));
    await waitFor(() => expect(screen.getByTitle('/srv/projects/mangostudio')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Select this folder' }));

    expect(onSelect).toHaveBeenCalledWith('/srv/projects/mangostudio');
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

    render(<WorkdirPickerDialog open chatId="chat-remote" onSelect={vi.fn()} onClose={vi.fn()} />);

    const pathInput = await screen.findByLabelText('Server path');
    await waitFor(() => expect(pathInput).toHaveValue('/home/mango'));
    await user.clear(pathInput);
    await user.type(pathInput, '/srv/manual');
    await user.click(screen.getByRole('button', { name: 'Open' }));

    await waitFor(() => expect(screen.getByTitle('/srv/manual')).toBeInTheDocument());
    expect(fetchScenario.fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/workspace/fs/validate'),
      expect.objectContaining({
        body: JSON.stringify({ path: '/srv/manual', chatId: 'chat-remote' }),
        method: 'POST',
      })
    );
  });
});
