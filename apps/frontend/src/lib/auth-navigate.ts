type AuthNavigateHandler = () => void;

let handler: AuthNavigateHandler | null = null;

export function setAuthNavigate(fn: AuthNavigateHandler) {
  handler = fn;
}

export function navigateToLoginPage() {
  handler?.();
}
