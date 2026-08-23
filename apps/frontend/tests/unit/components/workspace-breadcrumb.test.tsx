import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { screen } from '@testing-library/react';
import { WorkspaceBreadcrumbView } from '../../../src/features/workspace/components/WorkspaceBreadcrumb';
import { render } from '../../support/harness/render';

beforeEach(() => {
  window.localStorage.setItem('mangostudio:locale', 'en');
});

afterEach(() => {
  window.localStorage.clear();
});

describe('WorkspaceBreadcrumbView', () => {
  it('reads as "in <repo> / <branch>"', () => {
    render(
      <WorkspaceBreadcrumbView basename="mango-lsp-store" branch="feat/lsp-plugin" dirty={false} />
    );
    const breadcrumb = screen.getByTestId('workspace-breadcrumb');
    expect(breadcrumb).toHaveTextContent('in');
    expect(breadcrumb).toHaveTextContent('mango-lsp-store');
    expect(breadcrumb).toHaveTextContent('/');
    expect(breadcrumb).toHaveTextContent('feat/lsp-plugin');
    expect(screen.queryByText('Uncommitted changes')).toBeNull();
  });

  it('drops the branch segment when there is none', () => {
    render(<WorkspaceBreadcrumbView basename="scratch" branch={null} dirty={false} />);
    const breadcrumb = screen.getByTestId('workspace-breadcrumb');
    expect(breadcrumb).toHaveTextContent('scratch');
    expect(breadcrumb.textContent).not.toContain('/');
  });

  it('announces a dirty tree', () => {
    render(<WorkspaceBreadcrumbView basename="repo" branch="main" dirty={true} />);
    expect(screen.getByText('Uncommitted changes')).toBeInTheDocument();
  });
});
