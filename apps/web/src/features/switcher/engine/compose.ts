/** 1フレームの描画命令を作る（純粋関数）。Canvas への描画は media/compositor.ts が行う。 */
import { PROGRAM_SIZE, pipRect, type FitMode, type Rect, type Size } from './layout';
import { isCamera, type Scene, type SourceId } from './scene';
import { ease, transitionProgress } from './transition';
import type { ActiveTransition } from './state';

export type Layer = { source: SourceId; rect: Rect; fit: FitMode };
export type DrawOp = { layers: Layer[]; alpha: number; clip: Rect | null };

/** カメラは画面いっぱい（cover）、スライド・待機画面は全体を収める（contain）。 */
export const fitFor = (source: SourceId): FitMode => (isCamera(source) ? 'cover' : 'contain');

export function sceneLayers(scene: Scene, canvas: Size = PROGRAM_SIZE): Layer[] {
  const layers: Layer[] = [{ source: scene.main, rect: { x: 0, y: 0, w: canvas.width, h: canvas.height }, fit: fitFor(scene.main) }];
  if (scene.pip) layers.push({ source: scene.pip.sub, rect: pipRect(scene.pip.corner, scene.pip.size, canvas), fit: 'cover' });
  return layers;
}

/** トランジション中は「元の画」の上に「次の画」を重ねる。ディゾルブは不透明度、ワイプは左から右への切り抜き。 */
export function composeFrame(program: Scene, active: ActiveTransition | null, now: number, canvas: Size = PROGRAM_SIZE): DrawOp[] {
  if (!active) return [{ layers: sceneLayers(program, canvas), alpha: 1, clip: null }];
  const progress = ease(transitionProgress(active.startedAt, active.durationMs, now));
  const base: DrawOp = { layers: sceneLayers(active.from, canvas), alpha: 1, clip: null };
  if (active.type === 'dissolve') return [base, { layers: sceneLayers(active.to, canvas), alpha: progress, clip: null }];
  return [base, { layers: sceneLayers(active.to, canvas), alpha: 1, clip: { x: 0, y: 0, w: Math.round(canvas.width * progress), h: canvas.height } }];
}
