/**
 * One installation's pin state: a "Use this version" button, or a "Selected"
 * badge once it is the one the environment already pins to.
 *
 * Kept out of `RuntimeCard` and `InstallationList` because both need it —
 * the effective installation's own row and every row in "Other
 * installations" — and a pin is decided the same way in either place.
 */

import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { useI18n } from '@/hooks/use-i18n';

interface ToolchainActionProps {
  readonly path: string;
  readonly selected: boolean;
  readonly isPending: boolean;
  readonly onSelect: (path: string) => void;
}

export function ToolchainAction({ path, selected, isPending, onSelect }: ToolchainActionProps) {
  const { t } = useI18n();
  const e = t.environments.runtimes;

  if (selected) {
    return (
      <Badge variant="accent" data-testid="toolchain-selected">
        {e.selected}
      </Badge>
    );
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      loading={isPending}
      onClick={() => onSelect(path)}
      data-testid="toolchain-use-version"
    >
      {e.useThisVersion}
    </Button>
  );
}
