import { afterEach, describe, expect, it } from 'bun:test';

import type { ToolIdentity, ToolIdentityUpdate } from '@mangostudio/shared/tool-identity';
import { useQuery } from '@tanstack/react-query';

import { IdentityEditDialog } from '../../../../src/features/environments/identity/IdentityEditDialog';
import { toolIdentitiesQueryOptions } from '../../../../src/features/environments/identity/queries';
import { resolveToolIdentity } from '../../../../src/features/environments/identity/resolve';
import { fireEvent, render, screen, waitFor } from '../../../support/harness/render';
import { createFetchScenario } from '../../../support/mocks/create-fetch-scenario';

const SUBJECT = 'agent:claude';
const scenario = createFetchScenario();

class FakeIdentityServer {
  identity: ToolIdentity = {
    subjectKey: SUBJECT,
    displayName: 'Original',
    monogram: 'OR',
    image: null,
    updatedAt: 1,
  };
  readonly patches: ToolIdentityUpdate[] = [];
  readonly requests: string[] = [];
  failUpdate = false;
  failUpload = false;
  uploaded: File | null = null;

  install() {
    scenario.install();
    scenario.fetchMock.mockImplementation(async (input, init) => {
      const address =
        input instanceof Request ? input.url : input instanceof URL ? input.href : input;
      const url = new URL(address, 'http://localhost');
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      this.requests.push(method);
      const path = decodeURIComponent(url.pathname);
      if (method === 'GET' && path === '/api/tool-identities') {
        return Response.json({ identities: { [SUBJECT]: this.identity } });
      }
      if (method === 'POST' && path === `/api/tool-identities/${SUBJECT}/image`) {
        if (this.failUpload) return Response.json({ error: 'Upload rejected' }, { status: 500 });
        if (!(init?.body instanceof FormData)) throw new Error('Expected image FormData');
        this.uploaded = init.body.get('image') as File;
        this.identity = {
          ...this.identity,
          image: { source: 'upload', url: null, cached: true, cacheKey: 'uploaded' },
        };
        return Response.json({ identity: this.identity });
      }
      if (method !== 'PUT' || path !== `/api/tool-identities/${SUBJECT}`) {
        throw new Error(`Unexpected identity request: ${method} ${url.pathname}`);
      }
      if (this.failUpdate) return Response.json({ error: 'Update rejected' }, { status: 500 });
      const body = input instanceof Request ? await input.text() : init?.body;
      if (typeof body !== 'string') throw new Error('Expected JSON identity patch');
      const patch = JSON.parse(body) as ToolIdentityUpdate;
      this.patches.push(patch);
      this.identity = {
        ...this.identity,
        ...patch,
        image:
          patch.image === undefined
            ? this.identity.image
            : patch.image === null
              ? null
              : { source: 'url', url: patch.image.url, cached: patch.image.cache },
      };
      return Response.json({ identity: this.identity });
    });
    return this;
  }

  resolved() {
    return resolveToolIdentity({ [SUBJECT]: this.identity }, SUBJECT, 'Claude Code');
  }
}

afterEach(() => scenario.restore());

describe('tool identity dialog dirty patches', () => {
  it('keeps a concurrent name after props refresh while editing only the monogram', async () => {
    const server = new FakeIdentityServer().install();
    let closed = false;
    const close = () => {
      closed = true;
    };
    const view = render(
      <IdentityEditDialog identity={server.resolved()} defaultName="Claude Code" onClose={close} />
    );
    server.identity = { ...server.identity, displayName: 'Winner' };
    view.rerender(
      <IdentityEditDialog identity={server.resolved()} defaultName="Claude Code" onClose={close} />
    );
    fireEvent.change(screen.getByLabelText('Monogram'), { target: { value: 'ZZ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(closed).toBe(true));
    expect(server.identity.displayName).toBe('Winner');
    expect(server.identity.monogram).toBe('ZZ');
    expect(server.patches).toEqual([{ monogram: 'ZZ' }]);
  });

  it.each(['url', 'none'] as const)(
    'allows a name edit after an opening upload changes to %s',
    async (replacement) => {
      const server = new FakeIdentityServer().install();
      server.identity.image = { source: 'upload', url: null, cached: true, cacheKey: 'opening' };
      let closed = false;
      const close = () => {
        closed = true;
      };
      const view = render(
        <IdentityEditDialog
          identity={server.resolved()}
          defaultName="Claude Code"
          onClose={close}
        />
      );
      server.identity.image =
        replacement === 'url'
          ? { source: 'url', url: 'https://example.com/winner.webp', cached: false }
          : null;
      const winningImage = server.identity.image;
      view.rerender(
        <IdentityEditDialog
          identity={server.resolved()}
          defaultName="Claude Code"
          onClose={close}
        />
      );
      fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Renamed' } });
      expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(closed).toBe(true));
      expect(server.patches).toEqual([{ displayName: 'Renamed' }]);
      expect(server.identity.image).toEqual(winningImage);
    }
  );

  it('keeps a concurrent upload when the opening no-image mode was untouched', async () => {
    const server = new FakeIdentityServer().install();
    let closed = false;
    render(
      <IdentityEditDialog
        identity={server.resolved()}
        defaultName="Claude Code"
        onClose={() => {
          closed = true;
        }}
      />
    );
    server.identity = {
      ...server.identity,
      image: { source: 'upload', url: null, cached: true, cacheKey: 'winner' },
    };
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(closed).toBe(true));
    expect(server.identity.image?.cacheKey).toBe('winner');
    expect(server.patches).toEqual([{ displayName: 'Renamed' }]);
  });
});

function IdentityObserver() {
  const { data } = useQuery(toolIdentitiesQueryOptions());
  return <output data-testid="stored-name">{data?.identities[SUBJECT]?.displayName}</output>;
}

describe('tool identity save requests', () => {
  it('sends explicit clears for stored overrides', async () => {
    const server = new FakeIdentityServer().install();
    server.identity.image = { source: 'url', url: 'https://example.com/old.webp', cached: true };
    let closed = false;
    render(
      <IdentityEditDialog
        identity={server.resolved()}
        defaultName="Claude Code"
        onClose={() => {
          closed = true;
        }}
      />
    );
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: ' ' } });
    fireEvent.change(screen.getByLabelText('Monogram'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('radio', { name: 'No image' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(closed).toBe(true));
    expect(server.patches).toEqual([{ displayName: null, monogram: null, image: null }]);
  });

  it('closes a normalized no-op without writing', async () => {
    const server = new FakeIdentityServer().install();
    let closed = false;
    render(
      <IdentityEditDialog
        identity={server.resolved()}
        defaultName="Claude Code"
        onClose={() => {
          closed = true;
        }}
      />
    );
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: ' Original ' } });
    fireEvent.change(screen.getByLabelText('Monogram'), { target: { value: 'or' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(closed).toBe(true));
    expect(server.requests).toEqual([]);
  });

  it('omits an unchanged URL and caching choice after an external image update', async () => {
    const server = new FakeIdentityServer().install();
    server.identity.image = {
      source: 'url',
      url: 'https://example.com/opening.webp',
      cached: false,
    };
    let closed = false;
    const view = render(
      <IdentityEditDialog
        identity={server.resolved()}
        defaultName="Claude Code"
        onClose={() => {
          closed = true;
        }}
      />
    );
    server.identity.image = { source: 'upload', url: null, cached: true, cacheKey: 'winner' };
    view.rerender(
      <IdentityEditDialog
        identity={server.resolved()}
        defaultName="Claude Code"
        onClose={() => {
          closed = true;
        }}
      />
    );
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(closed).toBe(true));
    expect(server.patches).toEqual([{ displayName: 'Renamed' }]);
    expect(server.identity.image?.cacheKey).toBe('winner');
  });

  it('uploads a file without an empty PUT', async () => {
    const server = new FakeIdentityServer().install();
    let closed = false;
    render(
      <IdentityEditDialog
        identity={server.resolved()}
        defaultName="Claude Code"
        onClose={() => {
          closed = true;
        }}
      />
    );
    fireEvent.click(screen.getByRole('radio', { name: 'Upload' }));
    fireEvent.change(screen.getByLabelText('Choose a file…'), {
      target: { files: [new File(['png'], 'avatar.png', { type: 'image/png' })] },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(closed).toBe(true));
    expect(server.requests).toEqual(['POST']);
    expect(server.uploaded?.name).toBe('avatar.png');
    expect(server.identity.displayName).toBe('Original');
  });

  it.each(['update', 'upload'] as const)(
    'keeps errors open and refreshes after a failed %s',
    async (failure) => {
      const server = new FakeIdentityServer().install();
      server.failUpdate = failure === 'update';
      server.failUpload = failure === 'upload';
      let closed = false;
      render(
        <>
          <IdentityObserver />
          <IdentityEditDialog
            identity={server.resolved()}
            defaultName="Claude Code"
            onClose={() => {
              closed = true;
            }}
          />
        </>
      );
      await waitFor(() => expect(screen.getByTestId('stored-name')).toHaveTextContent('Original'));
      fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Renamed' } });
      fireEvent.click(screen.getByRole('radio', { name: 'Upload' }));
      fireEvent.change(screen.getByLabelText('Choose a file…'), {
        target: { files: [new File(['png'], 'avatar.png', { type: 'image/png' })] },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      expect(await screen.findByText('The changes could not be saved.')).toBeInTheDocument();
      expect(closed).toBe(false);
      expect(server.requests).toEqual(
        failure === 'update' ? ['GET', 'PUT', 'GET'] : ['GET', 'PUT', 'POST', 'GET']
      );
      expect(server.patches).toEqual(failure === 'update' ? [] : [{ displayName: 'Renamed' }]);
      await waitFor(() =>
        expect(screen.getByTestId('stored-name')).toHaveTextContent(
          failure === 'update' ? 'Original' : 'Renamed'
        )
      );
    }
  );
});
