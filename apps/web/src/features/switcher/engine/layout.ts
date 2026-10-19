/** 番組画面のレイアウト計算（純粋関数）。 */
import { z } from 'zod';

export type Size = { width: number; height: number };
export type Rect = { x: number; y: number; w: number; h: number };

export const PROGRAM_SIZE: Size = { width: 1280, height: 720 };
export const PROGRAM_FPS = 30;

export const CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const;
export type Corner = (typeof CORNERS)[number];
export const PIP_SIZES = ['small', 'medium', 'large'] as const;
export type PipSize = (typeof PIP_SIZES)[number];

/** サブ画面の幅（番組幅に対する比率）。 */
export const PIP_SCALE: Record<PipSize, number> = { small: 0.25, medium: 0.33, large: 0.4 };
/** 画面端からの余白（番組幅に対する比率）。 */
export const PIP_MARGIN = 0.025;

export const CornerSchema = z.enum(CORNERS);
export const PipSizeSchema = z.enum(PIP_SIZES);

/** PiP のサブ画面矩形（16:9、四隅に余白付きで配置）。 */
export function pipRect(corner: Corner, size: PipSize, canvas: Size = PROGRAM_SIZE): Rect {
  const w = Math.round(canvas.width * PIP_SCALE[size]);
  const h = Math.round((w * 9) / 16);
  const margin = Math.round(canvas.width * PIP_MARGIN);
  const x = corner.endsWith('left') ? margin : canvas.width - margin - w;
  const y = corner.startsWith('top') ? margin : canvas.height - margin - h;
  return { x, y, w, h };
}

export type FitMode = 'contain' | 'cover';
export type DrawRect = { sx: number; sy: number; sw: number; sh: number; dx: number; dy: number; dw: number; dh: number };

/**
 * 元映像 source を target に収める drawImage 用の矩形。
 * contain: 全体を収めて余白を残す（スライド・待機画面の文字を切らない）。cover: はみ出す部分を切り取る（カメラ）。
 */
export function fitRect(source: Size, target: Rect, mode: FitMode): DrawRect {
  const full = { sx: 0, sy: 0, sw: source.width, sh: source.height, dx: target.x, dy: target.y, dw: target.w, dh: target.h };
  if (source.width <= 0 || source.height <= 0 || target.w <= 0 || target.h <= 0) return full;
  const sourceRatio = source.width / source.height;
  const targetRatio = target.w / target.h;
  if (sourceRatio === targetRatio) return full;
  if (mode === 'contain') {
    if (sourceRatio > targetRatio) {
      const dh = target.w / sourceRatio;
      return { ...full, dy: target.y + (target.h - dh) / 2, dh };
    }
    const dw = target.h * sourceRatio;
    return { ...full, dx: target.x + (target.w - dw) / 2, dw };
  }
  if (sourceRatio > targetRatio) {
    const sw = source.height * targetRatio;
    return { ...full, sx: (source.width - sw) / 2, sw };
  }
  const sh = source.width / targetRatio;
  return { ...full, sy: (source.height - sh) / 2, sh };
}
