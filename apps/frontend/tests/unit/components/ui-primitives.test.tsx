import { describe, expect, it, jest } from 'bun:test';
import { fireEvent, screen } from '@testing-library/react';
import { Badge } from '../../../src/components/ui/Badge';
import { Chip } from '../../../src/components/ui/Chip';
import { EmptyState } from '../../../src/components/ui/EmptyState';
import { KbdHint } from '../../../src/components/ui/KbdHint';
import { MicroLabel } from '../../../src/components/ui/MicroLabel';
import { Skeleton } from '../../../src/components/ui/Skeleton';
import { StatusDot } from '../../../src/components/ui/StatusDot';
import { render } from '../../support/harness/render';

describe('Badge', () => {
  it.each([
    ['neutral', 'text-on-surface-variant'],
    ['success', 'text-success'],
    ['warning', 'text-warning'],
    ['error', 'text-error'],
    ['accent', 'text-primary'],
  ] as const)('renders the %s variant with its tone class', (variant, toneClass) => {
    render(
      <Badge variant={variant} data-testid="badge">
        open
      </Badge>
    );
    expect(screen.getByTestId('badge').className).toContain(toneClass);
  });

  it('lets call sites override single utilities', () => {
    render(
      <Badge variant="success" className="text-[9px]" data-testid="badge">
        open
      </Badge>
    );
    const className = screen.getByTestId('badge').className;
    expect(className).toContain('text-[9px]');
    expect(className).not.toContain('text-[10px]');
  });
});

describe('Chip', () => {
  it('renders a plain span without onClick', () => {
    render(<Chip label="model">gpt-5.6</Chip>);
    expect(screen.getByText('gpt-5.6')).toBeInTheDocument();
    expect(screen.getByText('model:')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders an interactive button with onClick and honours disabled', () => {
    const onClick = jest.fn();
    render(
      <Chip aria-label="Change workdir" onClick={onClick}>
        mango-lsp-store
      </Chip>
    );
    const chip = screen.getByRole('button', { name: 'Change workdir' });
    fireEvent.click(chip);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe('StatusDot', () => {
  it.each([
    ['accent', 'bg-primary'],
    ['success', 'bg-success'],
    ['warning', 'bg-warning'],
    ['error', 'bg-error'],
    ['neutral', 'bg-outline'],
  ] as const)('renders the %s tone', (tone, toneClass) => {
    const { container } = render(<StatusDot tone={tone} />);
    const dot = container.querySelector(`[data-tone="${tone}"]`);
    expect(dot?.className).toContain(toneClass);
    expect(dot?.className).not.toContain('animate-pulse');
  });

  it('pulses when asked and stays hidden from the accessibility tree', () => {
    const { container } = render(<StatusDot tone="warning" pulse />);
    const dot = container.querySelector('[data-tone="warning"]');
    expect(dot?.className).toContain('animate-pulse');
    expect(dot?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('MicroLabel', () => {
  it('renders the requested element with the micro-label class', () => {
    render(<MicroLabel as="h3">workspace</MicroLabel>);
    const label = screen.getByRole('heading', { level: 3, name: 'workspace' });
    expect(label.className).toContain('micro-label');
  });
});

describe('KbdHint', () => {
  it('renders the shortcut in a kbd element', () => {
    const { container } = render(<KbdHint keys="⌘K" />);
    const kbd = container.querySelector('kbd');
    expect(kbd?.textContent).toBe('⌘K');
  });
});

describe('Skeleton', () => {
  it('renders a decorative shimmer block', () => {
    const { container } = render(<Skeleton className="aspect-square" />);
    const block = container.querySelector('.skeleton-block');
    expect(block?.getAttribute('aria-hidden')).toBe('true');
    expect(block?.className).toContain('aspect-square');
  });
});

describe('EmptyState', () => {
  it('renders title, hint and action', () => {
    const onAction = jest.fn();
    render(
      <EmptyState
        title="No results"
        hint="Try another query"
        action={
          <button type="button" onClick={onAction}>
            Clear
          </button>
        }
      />
    );
    expect(screen.getByText('No results')).toBeInTheDocument();
    expect(screen.getByText('Try another query')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(onAction).toHaveBeenCalledTimes(1);
  });
});
