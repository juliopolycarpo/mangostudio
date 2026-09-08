import { createLazyFileRoute, useRouter } from '@tanstack/react-router';
import { OnboardingWizard } from '@/features/onboarding/OnboardingWizard';

export const Route = createLazyFileRoute('/welcome')({
  component: WelcomePage,
});

function WelcomePage() {
  const router = useRouter();
  const { redirect } = Route.useSearch();

  return (
    <OnboardingWizard
      // `history.push` takes the full href the guard preserved; `navigate({ to })`
      // wants a typed route path, and the destination here is whatever page the
      // person was originally asking for.
      onDone={() => router.history.push(redirect ?? '/')}
    />
  );
}
