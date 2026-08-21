import { describe, expect, it } from 'bun:test';
import type { McpMediaPart } from '@mangostudio/shared';
import { McpMediaPartBlock } from '../../../src/features/chat/components/McpMediaPartBlock';
import { render, screen } from '../../support/harness/render';

function makePart(overrides: Partial<McpMediaPart> = {}): McpMediaPart {
  return {
    type: 'mcp_media',
    toolCallId: 'call-1',
    serverSlug: 'charts',
    toolName: 'render',
    kind: 'image',
    mimeType: 'image/png',
    url: '/images/mcp-1.png',
    ...overrides,
  };
}

describe('McpMediaPartBlock', () => {
  it('renders an image part inline with its provenance', () => {
    render(<McpMediaPartBlock part={makePart()} />);

    const image = screen.getByAltText('Image returned by an MCP tool');
    expect(image).toHaveAttribute('src', '/images/mcp-1.png');
    expect(screen.getByText('From charts · render')).toBeInTheDocument();
  });

  it('renders a binary resource part as a download link', () => {
    render(
      <McpMediaPartBlock
        part={makePart({
          kind: 'resource',
          mimeType: 'application/pdf',
          url: '/uploads/report.pdf',
          uri: 'file:///report.pdf',
        })}
      />
    );

    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', '/uploads/report.pdf');
    expect(screen.getByText('file:///report.pdf')).toBeInTheDocument();
    expect(screen.getByText(/application\/pdf/)).toBeInTheDocument();
  });
});
