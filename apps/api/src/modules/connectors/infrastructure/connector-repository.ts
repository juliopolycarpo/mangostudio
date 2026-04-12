/**
 * Connector repository — typed DB operations for connector metadata.
 * Thin re-export of the secret-store metadata helpers with a module-local alias.
 */

export {
  listAllSecretMetadata,
  listSecretMetadata,
  getSecretMetadataById,
  upsertSecretMetadata,
  deleteSecretMetadata,
  type SecretMetadataInput,
} from '../../../services/secret-store/metadata';
