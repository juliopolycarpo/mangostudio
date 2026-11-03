import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';

import { DEFAULT_PROFILE_ID } from '@mangostudio/shared/profiles';
import type { KyselyPlugin, PluginTransformQueryArgs, PluginTransformResultArgs } from 'kysely';

import { getDb } from '../../../../src/db/database';
import { getConfig } from '../../../../src/lib/config';
import type { SafeFetchDeps } from '../../../../src/lib/safe-fetch';
import {
  resetToolIdentity,
  updateToolIdentity,
  uploadToolIdentityImage,
} from '../../../../src/modules/tool-identity/application/tool-identity-service';
import { getToolIdentityRow } from '../../../../src/modules/tool-identity/infrastructure/tool-identity-repository';
import { insertTestUser } from '../../../support/factories';

const PNG_BYTES = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
  ),
  (character) => character.charCodeAt(0)
);

/** A remote image pauses after the request reaches the host, outside any database transaction. */
class HeldImageHost {
  readonly requested = Promise.withResolvers<void>();
  private readonly response = Promise.withResolvers<Response>();
  readonly deps: Partial<SafeFetchDeps> = {
    fetch: this.fetch.bind(this) as unknown as typeof fetch,
    resolveHostname: this.resolveHostname,
  };

  fetch(): Promise<Response> {
    this.requested.resolve();
    return this.response.promise;
  }

  resolveHostname() {
    return Promise.resolve([{ address: '93.184.216.34', family: 4 as const }]);
  }

  release(): void {
    this.response.resolve(new Response(PNG_BYTES, { headers: { 'content-type': 'image/png' } }));
  }
}

/** A browser upload whose bytes have not arrived yet; the database remains available. */
class HeldUpload extends File {
  readonly requested = Promise.withResolvers<void>();
  private readonly released = Promise.withResolvers<void>();

  constructor() {
    super([PNG_BYTES], 'held.png', { type: 'image/png' });
  }

  override async arrayBuffer(): Promise<ArrayBuffer> {
    this.requested.resolve();
    await this.released.promise;
    return super.arrayBuffer();
  }

  release(): void {
    this.released.resolve();
  }
}

/** A controlled database write failure after image bytes have been staged. */
class RejectIdentityInsert implements KyselyPlugin {
  transformQuery({ node }: PluginTransformQueryArgs) {
    if (
      node.kind === 'InsertQueryNode' &&
      node.into?.table.identifier.name === 'user_tool_identities'
    ) {
      throw new Error('controlled identity insert failure');
    }
    return node;
  }

  transformResult({ result }: PluginTransformResultArgs) {
    return Promise.resolve(result);
  }
}

let userId: string;

function storedFiles(): string[] {
  const dir = join(getConfig().toolImages.dir, userId);
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

function pngFile(): File {
  return new File([PNG_BYTES], 'image.png', { type: 'image/png' });
}

function imagePatch(url: string) {
  return { image: { source: 'url' as const, url, cache: true } };
}

beforeEach(async () => {
  userId = (await insertTestUser()).id;
});

afterEach(() => {
  rmSync(join(getConfig().toolImages.dir, userId), { recursive: true, force: true });
});

describe('concurrent tool identity patches', () => {
  it('keeps both disjoint edits when two requests start together', async () => {
    const db = getDb();
    await updateToolIdentity(db, userId, 'agent:claude', { displayName: 'Old', monogram: 'OL' });
    await Promise.all([
      updateToolIdentity(db, userId, 'agent:claude', { displayName: 'New' }),
      updateToolIdentity(db, userId, 'agent:claude', { monogram: 'NW' }),
    ]);
    const stored = await getToolIdentityRow(db, userId, DEFAULT_PROFILE_ID, 'agent:claude');
    expect(stored?.displayName).toBe('New');
    expect(stored?.monogram).toBe('NW');
  });

  it('keeps both disjoint edits when racing to create the first row', async () => {
    const db = getDb();
    await Promise.all([
      updateToolIdentity(db, userId, 'agent:claude', { displayName: 'New' }),
      updateToolIdentity(db, userId, 'agent:claude', { monogram: 'NW' }),
    ]);
    const stored = await getToolIdentityRow(db, userId, DEFAULT_PROFILE_ID, 'agent:claude');
    expect(stored?.displayName).toBe('New');
    expect(stored?.monogram).toBe('NW');
  });

  it('deletes the row when concurrent partial resets remove every field', async () => {
    const db = getDb();
    await updateToolIdentity(db, userId, 'agent:claude', { displayName: 'Old', monogram: 'OL' });
    await Promise.all([
      updateToolIdentity(db, userId, 'agent:claude', { displayName: null }),
      updateToolIdentity(db, userId, 'agent:claude', { monogram: null }),
    ]);
    expect(
      await getToolIdentityRow(db, userId, DEFAULT_PROFILE_ID, 'agent:claude')
    ).toBeUndefined();
  });

  it('does not restore a reset field when another request creates a new name', async () => {
    const db = getDb();
    await updateToolIdentity(db, userId, 'agent:claude', { displayName: 'Old', monogram: 'OL' });
    await Promise.all([
      resetToolIdentity(db, userId, 'agent:claude'),
      updateToolIdentity(db, userId, 'agent:claude', { displayName: 'New' }),
    ]);
    const stored = await getToolIdentityRow(db, userId, DEFAULT_PROFILE_ID, 'agent:claude');
    expect(stored?.displayName).toBe('New');
    expect(stored?.monogram).toBeNull();
  });

  it('keeps a name changed while a remote image is downloading', async () => {
    const db = getDb();
    await updateToolIdentity(db, userId, 'agent:claude', { displayName: 'Old' });
    const remote = new HeldImageHost();
    const image = updateToolIdentity(
      db,
      userId,
      'agent:claude',
      imagePatch('https://cdn.example.test/first.png'),
      remote.deps
    );
    try {
      await remote.requested.promise;
      await updateToolIdentity(db, userId, 'agent:claude', { displayName: 'New' });
    } finally {
      remote.release();
    }
    expect((await image)?.displayName).toBe('New');
    expect(storedFiles()).toHaveLength(1);
  });

  it('keeps a name changed while upload bytes are arriving', async () => {
    const db = getDb();
    await updateToolIdentity(db, userId, 'agent:claude', { displayName: 'Old' });
    const file = new HeldUpload();
    const upload = uploadToolIdentityImage(db, userId, 'agent:claude', file);
    try {
      await file.requested.promise;
      await updateToolIdentity(db, userId, 'agent:claude', { displayName: 'New' });
    } finally {
      file.release();
    }
    expect((await upload).displayName).toBe('New');
    expect(storedFiles()).toHaveLength(1);
  });

  it('reclaims the image actually replaced after a concurrent upload', async () => {
    const db = getDb();
    await uploadToolIdentityImage(db, userId, 'agent:claude', pngFile());
    const remote = new HeldImageHost();
    const image = updateToolIdentity(
      db,
      userId,
      'agent:claude',
      imagePatch('https://cdn.example.test/last.png'),
      remote.deps
    );
    let replacedPath: string | null = null;
    try {
      await remote.requested.promise;
      await uploadToolIdentityImage(db, userId, 'agent:claude', pngFile());
      replacedPath =
        (await getToolIdentityRow(db, userId, DEFAULT_PROFILE_ID, 'agent:claude'))?.imagePath ??
        null;
    } finally {
      remote.release();
    }
    await image;
    const stored = await getToolIdentityRow(db, userId, DEFAULT_PROFILE_ID, 'agent:claude');
    expect(stored?.imagePath).not.toBeNull();
    expect(storedFiles()).toEqual([basename(stored?.imagePath ?? '')]);
    expect(replacedPath).not.toBeNull();
    expect(existsSync(join(getConfig().toolImages.dir, replacedPath ?? ''))).toBe(false);
  });

  it('rolls back staged bytes after a write fails without deleting the stored image', async () => {
    const db = getDb();
    await uploadToolIdentityImage(db, userId, 'agent:claude', pngFile());
    const previous = await getToolIdentityRow(db, userId, DEFAULT_PROFILE_ID, 'agent:claude');
    const previousFiles = storedFiles();
    await expect(
      uploadToolIdentityImage(
        db.withPlugin(new RejectIdentityInsert()),
        userId,
        'agent:claude',
        pngFile()
      )
    ).rejects.toThrow('controlled identity insert failure');
    expect(storedFiles()).toEqual(previousFiles);
    expect(await getToolIdentityRow(db, userId, DEFAULT_PROFILE_ID, 'agent:claude')).toEqual(
      previous
    );
  });
});
