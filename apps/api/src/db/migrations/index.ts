import { initialSchema } from './001_initial_schema';
import { addInteractionMode } from './002_add_interaction_mode';
import { addSecretMetadata } from './003_add_secret_metadata';
import { addIndexes } from './004_add_indexes';
import { multiConnectors } from './005_multi_connectors';
import { authTables } from './006_auth_tables';
import { addUserOwnership } from './007_add_user_ownership';
import { providerFields } from './008_provider_fields';

export const allMigrations = {
  '001_initial_schema': initialSchema,
  '002_add_interaction_mode': addInteractionMode,
  '003_add_secret_metadata': addSecretMetadata,
  '004_add_indexes': addIndexes,
  '005_multi_connectors': multiConnectors,
  '006_auth_tables': authTables,
  '007_add_user_ownership': addUserOwnership,
  '008_provider_fields': providerFields,
};
