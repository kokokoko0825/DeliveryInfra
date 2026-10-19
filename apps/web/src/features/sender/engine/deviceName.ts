import { DeviceNameSchema, STAGE_LIMITS } from '@delivery/shared';

export type SenderKind = 'camera' | 'mic';

const PREFIX: Record<SenderKind, string> = { camera: 'CAM', mic: 'MIC' };

/** 選択肢: カメラは CAM1〜CAM6、マイクは MIC1〜MIC5（上限台数と同じ数）。 */
export function deviceNameOptions(kind: SenderKind): string[] {
  return Array.from({ length: STAGE_LIMITS[kind] }, (_, index) => `${PREFIX[kind]}${index + 1}`);
}

/** 端末名の検証。問題なければ null、あればメッセージを返す。 */
export function validateDeviceName(kind: SenderKind, name: string): string | null {
  if (!DeviceNameSchema.safeParse(name).success) return '端末名は英数字とハイフンで1〜16文字にしてください';
  if (!deviceNameOptions(kind).includes(name)) return `端末名は ${deviceNameOptions(kind).join(' / ')} から選んでください`;
  return null;
}
