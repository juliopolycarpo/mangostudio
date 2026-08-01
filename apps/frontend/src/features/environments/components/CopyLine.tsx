/**
 * A labelled command with a copy button.
 *
 * Every "run this on that machine" affordance on the environments surface is
 * the same three parts — what it does, the exact string, a way to get it into
 * the clipboard — and the string is usually one the user must not retype from
 * a screenshot.
 */

import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useClipboard } from '@/hooks/use-clipboard';
import { useI18n } from '@/hooks/use-i18n';

interface CopyLineProps {
  readonly label: string;
  readonly value: string;
}

export function CopyLine({ label, value }: CopyLineProps) {
  const { t } = useI18n();
  const { copy, copied, failed } = useClipboard();

  return (
    <div className="space-y-1">
      <p className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant/70">
        {label}
      </p>
      <div className="flex items-start gap-2">
        <code className="min-w-0 flex-1 break-all rounded-lg bg-surface-container-highest px-2 py-1.5 font-mono text-[11px] text-on-surface">
          {value}
        </code>
        <Button variant="secondary" size="sm" onClick={() => void copy(value)}>
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? t.environments.actions.copied : t.environments.actions.copy}
        </Button>
      </div>
      {failed ? (
        <p className="text-[11px] text-error">{t.environments.actions.copyFailed}</p>
      ) : null}
    </div>
  );
}
