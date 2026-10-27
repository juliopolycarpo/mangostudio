import { type ReactNode, useCallback, useState } from 'react';

import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { useI18n } from '@/hooks/use-i18n';

const AMEND_CONFIRMED_KEY = 'mangostudio.git.amend-confirmed';

export interface AmendMode {
  /** The commit form replaces HEAD instead of adding a commit. */
  readonly active: boolean;
  /** Enters amend mode, through the confirmation the first time in a session. */
  readonly request: () => void;
  readonly exit: () => void;
  /** The confirmation dialog while it is asking, else null. Rendered once, by the owner. */
  readonly dialog: ReactNode;
}

/**
 * Whether the Repository panel is amending HEAD, owned by the panel rather than
 * the commit form.
 *
 * A clean working tree draws no commit form: nothing can be committed, and an
 * empty summary, a description and a dead "Commit changes" above "Working tree
 * clean" read as an invitation to commit. Amending is still possible there —
 * rewording HEAD needs no changes — so the mode lives above the form: the panel
 * menu can enter it, and entering it is what brings the form back, prefilled
 * with the HEAD message.
 *
 * Reset when the chat changes, so another chat never opens in amend mode and
 * coming back does not either, as remounting the form used to guarantee.
 *
 * @example
 * const amend = useAmendMode(chatId);
 * <MenuItem onSelect={amend.request}>…</MenuItem>
 * {amend.dialog}
 */
export function useAmendMode(chatId: string): AmendMode {
  const { t } = useI18n();
  const labels = t.git.amendConfirm;
  const [active, setActive] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [ownerChat, setOwnerChat] = useState(chatId);
  if (ownerChat !== chatId) {
    setOwnerChat(chatId);
    setActive(false);
    setConfirming(false);
  }
  // Stable: the form leaves the mode from an effect that lists it.
  const exit = useCallback(() => setActive(false), []);

  const request = () => {
    if (active) return;
    if (sessionStorage.getItem(AMEND_CONFIRMED_KEY) === 'true') {
      setActive(true);
      return;
    }
    setConfirming(true);
  };

  const cancel = () => setConfirming(false);

  const dialog = confirming ? (
    <Dialog
      size="sm"
      title={labels.title}
      description={labels.description}
      onClose={cancel}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={cancel}>
            {labels.cancel}
          </Button>
          <Button
            type="button"
            onClick={() => {
              sessionStorage.setItem(AMEND_CONFIRMED_KEY, 'true');
              setConfirming(false);
              setActive(true);
            }}
          >
            {labels.confirm}
          </Button>
        </>
      }
    />
  ) : null;

  return { active, request, exit, dialog };
}
