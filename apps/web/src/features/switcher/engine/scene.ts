/** ソース・シーン・PiP 設定の型と検証（純粋）。 */
import { z } from 'zod';
import { CornerSchema, PipSizeSchema, type Corner, type PipSize } from './layout';

/** カメラは端末名で識別する（再接続で参加者 ID が変わっても同じソースとして扱う）。 */
export type SourceId = `camera:${string}` | 'slide' | 'standby';
export const SLIDE: SourceId = 'slide';
export const STANDBY: SourceId = 'standby';
export const cameraSource = (deviceName: string): SourceId => `camera:${deviceName}`;
export const isCamera = (source: SourceId) => source.startsWith('camera:');

export const SourceIdSchema = z.custom<SourceId>((value) => typeof value === 'string' && (value === SLIDE || value === STANDBY || /^camera:.+$/.test(value)));

export type PipSettings = { sub: SourceId; corner: Corner; size: PipSize };
export type Scene = { main: SourceId; pip: PipSettings | null };

export const PipSettingsSchema = z.object({ sub: SourceIdSchema, corner: CornerSchema, size: PipSizeSchema });

/** サブ画面とメインが同じソースの PiP は無効。 */
export function validatePip(main: SourceId, pip: unknown): PipSettings | null {
  const parsed = PipSettingsSchema.safeParse(pip);
  if (!parsed.success || parsed.data.sub === main) return null;
  return parsed.data;
}

/** シーンが使うソース（メイン・サブ）。 */
export const sceneSources = (scene: Scene): SourceId[] => (scene.pip ? [scene.main, scene.pip.sub] : [scene.main]);

export function sourceLabel(source: SourceId): string {
  if (source === SLIDE) return 'スライド';
  if (source === STANDBY) return '待機画面';
  return source.slice('camera:'.length);
}
