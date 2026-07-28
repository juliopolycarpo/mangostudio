import { initialSchema } from './001_initial_schema';
import { addInteractionMode } from './002_add_interaction_mode';
import { addSecretMetadata } from './003_add_secret_metadata';
import { addIndexes } from './004_add_indexes';
import { multiConnectors } from './005_multi_connectors';
import { authTables } from './006_auth_tables';
import { addUserOwnership } from './007_add_user_ownership';
import { providerFields } from './008_provider_fields';
import { openaiProviderSplit } from './009_openai_provider_split';
import { openaiAuthContext } from './010_openai_auth_context';
import { messageParts } from './011_message_parts';
import { chatProviderState } from './012_chat_provider_state';
import { chatContextState } from './013_chat_context_state';
import { userProviderSettings } from './014_user_provider_settings';
import { userToolSettings } from './015_user_tool_settings';
import { generatedImages } from './016_generated_images';
import { chatAttachments } from './017_chat_attachments';
import { userAppSettings } from './018_user_app_settings';
import { observabilitySnapshot } from './019_observability_snapshot';
import { userAgentSettings } from './020_user_agent_settings';
import { chatAgentSelection } from './021_chat_agent_selection';
import { connectorUsageSamples } from './022_connector_usage_samples';
import { userSkillSettings } from './023_user_skill_settings';
import { mcpServers } from './024_mcp_servers';
import { chatTodos } from './025_chat_todos';
import { chatWorkdir } from './026_chat_workdir';
import { chatRestrictToolsToWorkdir } from './027_chat_restrict_tools_to_workdir';
import { fileCheckpoints } from './028_file_checkpoints';
import { environmentInstallRuns } from './029_environment_install_runs';
import { libraryLocationSettings } from './030_library_location_settings';
import { libraryDivergenceAcks } from './031_library_divergence_acks';
import { profileScopedRows } from './032_profile_scoped_rows';
import { profileScopedAppSettings } from './033_profile_scoped_app_settings';
import { scopedLibraryLocationSettings } from './034_scoped_library_location_settings';

export const allMigrations = {
  '001_initial_schema': initialSchema,
  '002_add_interaction_mode': addInteractionMode,
  '003_add_secret_metadata': addSecretMetadata,
  '004_add_indexes': addIndexes,
  '005_multi_connectors': multiConnectors,
  '006_auth_tables': authTables,
  '007_add_user_ownership': addUserOwnership,
  '008_provider_fields': providerFields,
  '009_openai_provider_split': openaiProviderSplit,
  '010_openai_auth_context': openaiAuthContext,
  '011_message_parts': messageParts,
  '012_chat_provider_state': chatProviderState,
  '013_chat_context_state': chatContextState,
  '014_user_provider_settings': userProviderSettings,
  '015_user_tool_settings': userToolSettings,
  '016_generated_images': generatedImages,
  '017_chat_attachments': chatAttachments,
  '018_user_app_settings': userAppSettings,
  '019_observability_snapshot': observabilitySnapshot,
  '020_user_agent_settings': userAgentSettings,
  '021_chat_agent_selection': chatAgentSelection,
  '022_connector_usage_samples': connectorUsageSamples,
  '023_user_skill_settings': userSkillSettings,
  '024_mcp_servers': mcpServers,
  '025_chat_todos': chatTodos,
  '026_chat_workdir': chatWorkdir,
  '027_chat_restrict_tools_to_workdir': chatRestrictToolsToWorkdir,
  '028_file_checkpoints': fileCheckpoints,
  '029_environment_install_runs': environmentInstallRuns,
  '030_library_location_settings': libraryLocationSettings,
  '031_library_divergence_acks': libraryDivergenceAcks,
  '032_profile_scoped_rows': profileScopedRows,
  '033_profile_scoped_app_settings': profileScopedAppSettings,
  '034_scoped_library_location_settings': scopedLibraryLocationSettings,
};
