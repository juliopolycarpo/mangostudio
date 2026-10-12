import { Check, Copy } from 'lucide-react';
import { useClipboard } from '@/hooks/use-clipboard';
import { useI18n } from '@/hooks/use-i18n';

interface SignInCommandProps {
  /** The vendor's own sign-in command. Shown as plain text, never interpreted. */
  command: string;
  className?: string;
}

/**
 * The command a signed-out user runs, with a copy button.
 *
 * MangoStudio cannot run it for them: it has to run on the machine that hosts the agent. The
 * command is rendered as a text node, so whatever it contains stays inert.
 *
 * // Usage: <SignInCommand command={descriptor.loginCommand} />
 */
export function SignInCommand({ command, className }: SignInCommandProps) {
  const { t } = useI18n();
  const { copy, copied } = useClipboard();
  return (
    <div className={`flex items-center gap-2 ${className ?? ''}`}>
      <code className="min-w-0 flex-1 truncate rounded-lg bg-surface-container-high px-2 py-1 text-[10px] text-on-surface-variant">
        {command}
      </code>
      <button
        type="button"
        onClick={() => copy(command)}
        aria-label={t.externalAgents.selector.copyLoginCommand}
        className="shrink-0 rounded-lg p-1 text-on-surface-variant transition-colors hover:bg-surface-container-high"
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
      </button>
    </div>
  );
}
