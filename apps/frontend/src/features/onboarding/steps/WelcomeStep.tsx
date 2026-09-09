/**
 * What MangoStudio is, before anything is asked of the person.
 *
 * Three sentences, each one answering a question a first-time reader actually
 * has: where does this run, who answers me, and can I undo it.
 */

import { FolderTree, ShieldCheck, Sparkles } from 'lucide-react';
import { useI18n } from '@/hooks/use-i18n';
import { StepFrame } from '../StepFrame';

export function WelcomeStep() {
  const { t } = useI18n();
  const s = t.onboarding.welcome;
  const points = [
    { key: 'folder', Icon: FolderTree, text: s.folderPoint },
    { key: 'runner', Icon: Sparkles, text: s.runnerPoint },
    { key: 'control', Icon: ShieldCheck, text: s.controlPoint },
  ];

  return (
    <StepFrame title={s.title} lead={s.lead}>
      <ul className="space-y-3">
        {points.map(({ key, Icon, text }) => (
          <li key={key} className="flex items-start gap-3">
            <Icon aria-hidden size={16} className="mt-0.5 shrink-0 text-primary" />
            <span className="text-on-surface-variant text-sm leading-relaxed">{text}</span>
          </li>
        ))}
      </ul>
    </StepFrame>
  );
}
