/**
 * A command with a copy button, and optionally a label saying what it does.
 *
 * Every "run this on that machine" affordance on the environments surface is
 * the same three parts — what it does, the exact string, a way to get it into
 * the clipboard — and the string is usually one the user must not retype from
 * a screenshot. The command is mono on `canvas`, one step off the card it sits
 * in, the way a console reads.
 */

import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useClipboard } from '@/hooks/use-clipboard';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_SM } from '@/lib/icon-sizes';

interface CopyLineProps {
  /** What the command does. Omitted where the sentence above it already says. */
  readonly label?: string;
  readonly value: string;
}

export function CopyLine({ label, value }: CopyLineProps) {
  const { t } = useI18n();
  const { copy, copied, failed } = useClipboard();

  return (
    <div className="space-y-1">
      {label ? <p className="text-xs text-fg-muted">{label}</p> : null}
      <div className="flex items-start gap-2">
        <code className="min-w-0 flex-1 break-all rounded-md border border-stroke bg-canvas px-3 py-2 font-mono text-xs text-fg">
          {value}
        </code>
        <Button variant="secondary" onClick={() => void copy(value)}>
          {copied ? <Check size={ICON_SM} /> : <Copy size={ICON_SM} />}
          {copied ? t.environments.actions.copied : t.environments.actions.copy}
        </Button>
      </div>
      {failed ? <p className="text-xs text-danger">{t.environments.actions.copyFailed}</p> : null}
    </div>
  );
}
