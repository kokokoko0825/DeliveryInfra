import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AppErrorBoundary } from './AppErrorBoundary';

function BrokenView(): never {
  throw new Error('render failed');
}

describe('AppErrorBoundary', () => {
  it('shows the fallback and reports when the diagnostic download fails', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubGlobal('URL', { ...URL, createObjectURL: () => { throw new Error('download denied'); }, revokeObjectURL: vi.fn() });

    render(<AppErrorBoundary><BrokenView /></AppErrorBoundary>);
    expect(screen.getByRole('heading', { name: '画面を表示できませんでした' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '診断ログを保存' }));
    expect(screen.getByText('診断ログを保存できませんでした。')).toBeInTheDocument();
  });
});
