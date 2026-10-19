import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './dialog';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from './sheet';
import { Sidebar, SidebarProvider, SidebarTrigger } from './sidebar';

afterEach(() => vi.unstubAllGlobals());

// R4-06: 読み上げは日本語、閉じるボタンは 44px（size-11）以上のタップ領域
describe('overlay accessibility (R4-06)', () => {
  it('labels the dialog close button in Japanese with a 44px target', () => {
    render(<Dialog open><DialogContent><DialogTitle>スライド</DialogTitle><DialogDescription>PDF</DialogDescription></DialogContent></Dialog>);
    const close = screen.getByRole('button', { name: '閉じる' });
    expect(close).toHaveClass('size-11');
    expect(screen.queryByText('Close')).not.toBeInTheDocument();
  });

  it('labels the sheet close button in Japanese with a 44px target', () => {
    render(<Sheet open><SheetContent><SheetTitle>メニュー</SheetTitle><SheetDescription>説明</SheetDescription></SheetContent></Sheet>);
    expect(screen.getByRole('button', { name: '閉じる' })).toHaveClass('size-11');
  });

  it('names the mobile sidebar and its toggle in Japanese', async () => {
    vi.stubGlobal('innerWidth', 375);
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: true, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    render(<SidebarProvider defaultOpen><SidebarTrigger /><Sidebar><p>リンク</p></Sidebar></SidebarProvider>);
    expect(screen.getByRole('button', { name: 'メニューを開閉' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'メニューを開閉' }));
    expect(await screen.findByRole('dialog', { name: 'メインメニュー' })).toHaveAccessibleDescription('ページを移動します');
  });
});
