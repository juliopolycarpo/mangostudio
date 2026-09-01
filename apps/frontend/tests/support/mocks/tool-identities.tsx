/**
 * Feeds a real `useToolIdentities()` resolver to a render-prop child.
 *
 * The lift in follow-up #3 on PR #991 moved identity resolution out of every
 * per-row component and into `ChatFeed`, so a unit test that mounts a row
 * component directly (`TurnSeparator`, `MessageParts`, `ExternalActivityBlock`)
 * now has to supply the resolver as a prop instead of it appearing for free.
 * This calls the real, unmocked hook — the same one those rows called
 * themselves before the lift — so a test asserting a resolved name still
 * exercises the real `resolveToolIdentity` path rather than a faked one.
 *
 * Usage:
 * ```tsx
 * render(
 *   <ToolIdentitiesProbe>
 *     {(toolIdentities) => <TurnSeparator msg={msg} toolIdentities={toolIdentities} ... />}
 *   </ToolIdentitiesProbe>
 * );
 * ```
 */

import type { ReactElement } from 'react';
import type { ToolIdentityResolver } from '@/features/environments/identity/use-tool-identities';
import { useToolIdentities } from '@/features/environments/identity/use-tool-identities';

export function ToolIdentitiesProbe({
  children,
}: {
  children: (toolIdentities: ToolIdentityResolver) => ReactElement;
}): ReactElement {
  const toolIdentities = useToolIdentities();
  return children(toolIdentities);
}
