import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Slider } from './slider';

describe('Slider', () => {
  it('keeps a 44px pointer area around the thin track and 16px thumb (Apple HIG, R2-05)', () => {
    const { container } = render(<><Slider aria-label="音量" value={[50]} /><Slider aria-label="縦" orientation="vertical" value={[50]} /></>);
    const [horizontal, vertical] = container.querySelectorAll('[data-slot="slider"]');
    expect(horizontal).toHaveAttribute('data-orientation', 'horizontal');
    expect(horizontal).toHaveClass('data-[orientation=horizontal]:min-h-11');
    expect(vertical).toHaveClass('data-[orientation=vertical]:min-w-11');
    // 見た目は維持する
    expect(horizontal?.querySelector('[data-slot="slider-track"]')).toHaveClass('data-[orientation=horizontal]:h-1.5');
    expect(screen.getAllByRole('slider')[0]).toHaveClass('size-4');
  });
});
