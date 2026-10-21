import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useClipboard } from '@/hooks/use-clipboard';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_MD } from '@/lib/icon-sizes';
import { cn } from '@/lib/utils';

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
    <div className={cn('flex items-center gap-2', className)}>
      {/* As tall as the copy button beside it (and as tall as its 44px on a touch
          screen), with the command centred in it: a field sized by its padding
          came out a few pixels short of the button. */}
      <div className="flex h-7 min-w-0 flex-1 items-center rounded-md border border-stroke bg-canvas px-2 pointer-coarse:h-11">
        <code className="min-w-0 truncate font-mono text-xs text-fg">{command}</code>
      </div>
      <Button
        variant="subtle"
        size="sm"
        onClick={() => copy(command)}
        aria-label={t.externalAgents.selector.copyLoginCommand}
        className="shrink-0"
      >
        {copied ? <Check size={ICON_MD} /> : <Copy size={ICON_MD} />}
      </Button>
    </div>
  );
}
