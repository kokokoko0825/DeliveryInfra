import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canSetVolume, VideoPlayer } from './VideoPlayer';

/** iOS Safari と同じく volume を読み取り専用（常に 1）にする。 */
function makeVolumeReadOnly() {
  vi.spyOn(HTMLMediaElement.prototype, 'volume', 'get').mockReturnValue(1);
  vi.spyOn(HTMLMediaElement.prototype, 'volume', 'set').mockImplementation(() => undefined);
}

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('VideoPlayer', () => {
  it('detects whether the volume can be changed (R3-07)', () => {
    expect(canSetVolume()).toBe(true);
    makeVolumeReadOnly();
    expect(canSetVolume()).toBe(false);
  });

  it('shows the volume slider where volume works and applies it', () => {
    render(<VideoPlayer stream={null} />);
    expect(screen.getByLabelText('音量')).toBeInTheDocument();
    expect(screen.getByRole('slider')).toBeInTheDocument();
    const video = screen.getByLabelText<HTMLVideoElement>('配信映像');
    expect(video.muted).toBe(true);
    expect(video.volume).toBe(1);
  });

  it('hides the volume slider on iOS and keeps mute control (R3-07)', () => {
    makeVolumeReadOnly();
    render(<VideoPlayer stream={null} />);
    expect(screen.queryByLabelText('音量')).not.toBeInTheDocument();
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
    const video = screen.getByLabelText<HTMLVideoElement>('配信映像');
    fireEvent.click(screen.getByRole('button', { name: 'タップして音声オン' }));
    expect(video.muted).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'ミュート' }));
    expect(video.muted).toBe(true);
    expect(screen.getByRole('button', { name: 'ミュート解除' })).toHaveAttribute('aria-pressed', 'true');
  });
});
