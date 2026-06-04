import logoUrl from '@/assets/logo.webp';
import { useI18n } from '@/hooks/use-i18n';

interface LogoProps {
  className?: string;
  alt?: string;
}

export function Logo({ className = '', alt }: LogoProps) {
  const { t } = useI18n();
  return (
    <img
      src={logoUrl}
      alt={alt ?? t.common.mangoStudioLogo}
      className={`object-contain ${className}`}
      draggable={false}
    />
  );
}
