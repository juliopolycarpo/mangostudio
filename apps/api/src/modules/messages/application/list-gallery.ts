import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import { listGalleryImages } from '../infrastructure/message-repository';

export interface ListGalleryInput {
  userId: string;
  cursor?: number;
  limit?: number;
}

export async function listGalleryUseCase(input: ListGalleryInput, db: Kysely<Database>) {
  return listGalleryImages(input.userId, { cursor: input.cursor, limit: input.limit }, db);
}
