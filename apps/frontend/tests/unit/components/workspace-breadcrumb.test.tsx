import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { screen, within } from '@testing-library/react';
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
    // Segment-by-segment, not substring: the branch fixture keeps a `/` on
    // purpose, and against the whole line `toHaveTextContent('/')` — and
    // `('in')`, which "lsp-plugin" also contains — would pass on the branch
    // alone even with the label and the separator gone.
    const breadcrumb = screen.getByTestId('workspace-breadcrumb');
    expect(within(breadcrumb).getByText('in')).toBeInTheDocument();
    expect(within(breadcrumb).getByText('mango-lsp-store')).toBeInTheDocument();
    expect(within(breadcrumb).getByText('/')).toBeInTheDocument();
    expect(within(breadcrumb).getByText('feat/lsp-plugin')).toBeInTheDocument();
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
