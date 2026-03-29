import logoUrl from '@/assets/logo.svg';

interface LogoProps {
  className?: string;
  alt?: string;
}

export function Logo({ className = '', alt = 'Mango Studio Logo' }: LogoProps) {
  return (
    <img src={logoUrl} alt={alt} className={`object-contain ${className}`} draggable={false} />
  );
}
