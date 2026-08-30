import { createLazyFileRoute } from '@tanstack/react-router';
import { McpSettingsPage } from '@/features/settings/mcp';

export const Route = createLazyFileRoute('/_authenticated/settings/mcp')({
  component: McpSettingsPage,
});
