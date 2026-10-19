/** engine/compose の描画命令を Canvas 2D に描く。 */
import type { DrawOp } from '../engine/compose';
import { fitRect, type Size } from '../engine/layout';
import type { SourceId } from '../engine/scene';

export type Drawable = CanvasImageSource & ({ videoWidth: number; videoHeight: number } | { width: number; height: number });
export type ResolveSource = (source: SourceId) => Drawable | null;

// 映像そのものの背景（UI の配色ではない）
const VIDEO_BLACK = 'black';

const sizeOf = (image: Drawable): Size =>
  'videoWidth' in image ? { width: image.videoWidth, height: image.videoHeight } : { width: Number(image.width), height: Number(image.height) };

export function drawFrame(context: CanvasRenderingContext2D, ops: DrawOp[], resolve: ResolveSource, canvas: Size) {
  context.globalAlpha = 1;
  context.fillStyle = VIDEO_BLACK;
  context.fillRect(0, 0, canvas.width, canvas.height);
  for (const op of ops) {
    if (op.alpha <= 0 || op.clip?.w === 0) continue;
    context.save();
    context.globalAlpha = op.alpha;
    if (op.clip) {
      context.beginPath();
      context.rect(op.clip.x, op.clip.y, op.clip.w, op.clip.h);
      context.clip();
    }
    for (const layer of op.layers) {
      // 下の画が透けないよう、各レイヤーの領域を先に黒で埋める
      context.fillStyle = VIDEO_BLACK;
      context.fillRect(layer.rect.x, layer.rect.y, layer.rect.w, layer.rect.h);
      const image = resolve(layer.source);
      if (!image) continue;
      const size = sizeOf(image);
      if (size.width === 0 || size.height === 0) continue;
      const r = fitRect(size, layer.rect, layer.fit);
      context.drawImage(image, r.sx, r.sy, r.sw, r.sh, r.dx, r.dy, r.dw, r.dh);
    }
    context.restore();
  }
}

/** 既定の待機画面（静止画）。 */
export function createDefaultStandby(size: Size): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext('2d');
  if (context) {
    context.fillStyle = VIDEO_BLACK;
    context.fillRect(0, 0, size.width, size.height);
    context.fillStyle = 'white';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.font = `600 ${Math.round(size.height / 14)}px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`;
    context.fillText('しばらくお待ちください', size.width / 2, size.height / 2);
  }
  return canvas;
}

/** アップロードされた画像ファイルを待機画面として読み込む。 */
export function loadStandbyImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) {
      reject(new Error('画像ファイルを選んでください'));
      return;
    }
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('画像を読み込めませんでした'));
    };
    image.src = url;
  });
}
