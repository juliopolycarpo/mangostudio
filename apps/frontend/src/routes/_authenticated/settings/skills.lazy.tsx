import { createLazyFileRoute } from '@tanstack/react-router';
import { SkillsSettingsPage } from '@/features/settings/skills';

export const Route = createLazyFileRoute('/_authenticated/settings/skills')({
  component: SkillsSettingsPage,
});
