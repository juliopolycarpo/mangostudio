/**
 * Connector repository — typed DB operations for connector metadata.
 * Thin re-export of the secret-store metadata helpers with a module-local alias.
 */

export {
  deleteSecretMetadata,
  getSecretMetadataById,
  listAllSecretMetadata,
  listSecretMetadata,
  type SecretMetadataInput,
  upsertSecretMetadata,
} from '../../../services/secret-store/metadata';
