import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useClipboard } from '@/hooks/use-clipboard';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_SM } from '@/lib/icon-sizes';
import { cn } from '@/lib/utils';

interface SignInCommandProps {
  /** The vendor's own sign-in command. Shown as plain text, never interpreted. */
  command: string;
  className?: string;
}

/**
 * The command a signed-out user runs, with a copy button inside the field's right edge.
 * The one field for every place the product asks for a vendor command to be run.
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
    // One field, the copy button inside its right edge: a button floating beside
    // a bare field read as two unrelated things. The container takes its height
    // from the button, so the 44px touch floor needs no second rule here.
    <div
      className={cn(
        'flex min-w-0 items-center gap-1 rounded-md border border-stroke bg-canvas p-0.5 pl-2',
        className
      )}
    >
      <code className="min-w-0 flex-1 truncate font-mono text-xs text-fg">{command}</code>
      <Button
        variant="subtle"
        size="sm"
        onClick={() => copy(command)}
        aria-label={t.externalAgents.selector.copyLoginCommand}
        className="shrink-0"
      >
        {copied ? <Check size={ICON_SM} /> : <Copy size={ICON_SM} />}
      </Button>
    </div>
  );
}
