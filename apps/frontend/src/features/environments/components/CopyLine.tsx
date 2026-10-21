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
      {/* Stacked below `sm`: beside the button a short command is left a
          sliver, and wrapping it there splits a word. `break-words` wraps at
          a space first and only breaks inside a token that cannot fit. The
          field is on the control rhythm — at least 32px, `rounded-sm` — so it
          meets the button beside it edge for edge, as a path field and its
          button do; a long command grows it rather than being cut. */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <code className="flex min-h-8 min-w-0 flex-1 items-center break-words rounded-sm border border-stroke bg-canvas px-3 py-1 font-mono text-xs text-fg">
          <span className="min-w-0">{value}</span>
        </code>
        <Button variant="secondary" className="w-full sm:w-auto" onClick={() => void copy(value)}>
          {copied ? <Check size={ICON_SM} /> : <Copy size={ICON_SM} />}
          {copied ? t.environments.actions.copied : t.environments.actions.copy}
        </Button>
      </div>
      {failed ? <p className="text-xs text-danger">{t.environments.actions.copyFailed}</p> : null}
    </div>
  );
}
