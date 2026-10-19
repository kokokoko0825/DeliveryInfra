import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DrawOp } from '../engine/compose';
import { cameraSource, SLIDE, STANDBY } from '../engine/scene';
import { createDefaultStandby, drawFrame, loadStandbyImage, type Drawable } from './compositor';

/** CanvasRenderingContext2D の呼び出しとプロパティ代入を順に記録する。 */
function recordingContext() {
  const calls: unknown[][] = [];
  const target: Record<string, unknown> = {};
  const context = new Proxy(target, {
    get: (_, key: string) => (key in target ? target[key] : (...args: unknown[]) => { calls.push([key, ...args]); }),
    set: (_, key: string, value: unknown) => { target[key] = value; calls.push([`${key}=`, value]); return true; },
  });
  return { context: context as unknown as CanvasRenderingContext2D, calls };
}

const CANVAS = { width: 1280, height: 720 };
const CAM1 = cameraSource('CAM1');
const full = { x: 0, y: 0, w: 1280, h: 720 };
const video = (width: number, height: number) => ({ videoWidth: width, videoHeight: height }) as unknown as Drawable;
const image = (width: number, height: number) => ({ width, height }) as unknown as Drawable;

afterEach(() => vi.restoreAllMocks());

describe('drawFrame', () => {
  it('clears to opaque black before drawing anything', () => {
    const { context, calls } = recordingContext();
    drawFrame(context, [], () => null, CANVAS);
    expect(calls).toEqual([['globalAlpha=', 1], ['fillStyle=', 'black'], ['fillRect', 0, 0, 1280, 720]]);
  });

  it('draws a camera with cover and a slide with contain inside a saved, opaque op', () => {
    const { context, calls } = recordingContext();
    const camera = video(1920, 1080);
    const slide = image(1000, 1000);
    const ops: DrawOp[] = [{ layers: [{ source: CAM1, rect: full, fit: 'cover' }, { source: SLIDE, rect: { x: 826, y: 451, w: 422, h: 237 }, fit: 'contain' }], alpha: 1, clip: null }];
    drawFrame(context, ops, (source) => (source === CAM1 ? camera : slide), CANVAS);
    expect(calls.slice(3)).toEqual([
      ['save'], ['globalAlpha=', 1],
      ['fillStyle=', 'black'], ['fillRect', 0, 0, 1280, 720],
      ['drawImage', camera, 0, 0, 1920, 1080, 0, 0, 1280, 720],
      ['fillStyle=', 'black'], ['fillRect', 826, 451, 422, 237],
      // 正方形のスライドを横長の枠に contain → 高さ合わせで左右に余白
      ['drawImage', slide, 0, 0, 1000, 1000, 918.5, 451, 237, 237],
      ['restore'],
    ]);
  });

  it('crops with cover so a 4:3 camera fills 16:9 without distortion', () => {
    const { context, calls } = recordingContext();
    const camera = video(640, 480);
    drawFrame(context, [{ layers: [{ source: CAM1, rect: full, fit: 'cover' }], alpha: 1, clip: null }], () => camera, CANVAS);
    expect(calls.find((call) => call[0] === 'drawImage')).toEqual(['drawImage', camera, 0, 60, 640, 360, 0, 0, 1280, 720]);
  });

  it('dissolves the upper picture with alpha while the lower stays opaque (A-01)', () => {
    const { context, calls } = recordingContext();
    const ops: DrawOp[] = [
      { layers: [{ source: STANDBY, rect: full, fit: 'contain' }], alpha: 1, clip: null },
      { layers: [{ source: CAM1, rect: full, fit: 'cover' }], alpha: 0.25, clip: null },
    ];
    drawFrame(context, ops, () => video(1280, 720), CANVAS);
    expect(calls.filter((call) => call[0] === 'globalAlpha=').map((call) => call[1])).toEqual([1, 1, 0.25]);
    expect(calls.filter((call) => call[0] === 'save')).toHaveLength(2);
    expect(calls.filter((call) => call[0] === 'restore')).toHaveLength(2);
  });

  it('wipes by clipping the upper picture to the progress width', () => {
    const { context, calls } = recordingContext();
    drawFrame(context, [{ layers: [{ source: CAM1, rect: full, fit: 'cover' }], alpha: 1, clip: { x: 0, y: 0, w: 320, h: 720 } }], () => video(1280, 720), CANVAS);
    expect(calls.slice(3, 8)).toEqual([['save'], ['globalAlpha=', 1], ['beginPath'], ['rect', 0, 0, 320, 720], ['clip']]);
  });

  it('skips invisible ops: zero alpha and zero-width wipe', () => {
    const { context, calls } = recordingContext();
    const layers = [{ source: CAM1, rect: full, fit: 'cover' as const }];
    drawFrame(context, [{ layers, alpha: 0, clip: null }, { layers, alpha: -0.1, clip: null }, { layers, alpha: 1, clip: { x: 0, y: 0, w: 0, h: 720 } }], () => video(1280, 720), CANVAS);
    expect(calls).toHaveLength(3);
  });

  it('paints black and skips drawing for missing or not-yet-decoded sources', () => {
    const { context, calls } = recordingContext();
    const layers = [CAM1, SLIDE, STANDBY].map((source) => ({ source, rect: full, fit: 'cover' as const }));
    const resolve = (source: string) => (source === CAM1 ? null : source === SLIDE ? video(0, 720) : image(1280, 0));
    drawFrame(context, [{ layers, alpha: 1, clip: null }], resolve, CANVAS);
    expect(calls.filter((call) => call[0] === 'fillRect')).toHaveLength(4);
    expect(calls.some((call) => call[0] === 'drawImage')).toBe(false);
  });
});

describe('createDefaultStandby', () => {
  it('draws the waiting message centred on black at the program size', () => {
    const { context, calls } = recordingContext();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as never);
    const canvas = createDefaultStandby(CANVAS);
    expect([canvas.width, canvas.height]).toEqual([1280, 720]);
    expect(calls).toEqual([
      ['fillStyle=', 'black'], ['fillRect', 0, 0, 1280, 720], ['fillStyle=', 'white'], ['textAlign=', 'center'], ['textBaseline=', 'middle'],
      ['font=', "600 51px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"], ['fillText', 'しばらくお待ちください', 640, 360],
    ]);
  });

  it('still returns a canvas when 2D is unavailable', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    expect(createDefaultStandby({ width: 4, height: 2 })).toMatchObject({ width: 4, height: 2 });
  });
});

describe('loadStandbyImage', () => {
  class FakeImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    src = '';
  }
  const images: FakeImage[] = [];
  const stubImage = () => {
    images.length = 0;
    vi.stubGlobal('Image', class extends FakeImage { constructor() { super(); images.push(this); } });
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:standby'), revokeObjectURL: vi.fn() }));
  };
  afterEach(() => vi.unstubAllGlobals());

  it('rejects non-image files without reading them', async () => {
    stubImage();
    await expect(loadStandbyImage(new File(['x'], 'a.txt', { type: 'text/plain' }))).rejects.toThrow('画像ファイルを選んでください');
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('resolves with the loaded image', async () => {
    stubImage();
    const loading = loadStandbyImage(new File(['x'], 'a.png', { type: 'image/png' }));
    expect(images[0]?.src).toBe('blob:standby');
    images[0]?.onload?.();
    await expect(loading).resolves.toBe(images[0]);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  });

  it('revokes the object URL and rejects when decoding fails', async () => {
    stubImage();
    const loading = loadStandbyImage(new File(['x'], 'a.jpg', { type: 'image/jpeg' }));
    images[0]?.onerror?.();
    await expect(loading).rejects.toThrow('画像を読み込めませんでした');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:standby');
  });
});
