/** 受信ソースの並び・健全性判定（純粋）。 */
import { STAGE_LIMITS } from '@delivery/shared';

export const MAX_CAMERAS = STAGE_LIMITS.camera;
/** 最後のフレームからこの時間が経つと「映像途絶」とみなす。 */
export const STALL_THRESHOLD_MS = 2000;

export type SourceHealth = 'live' | 'stalled' | 'disconnected';
export type HealthInput = { connected: boolean; lastFrameAt: number | null };

export function healthOf(input: HealthInput, now: number, thresholdMs = STALL_THRESHOLD_MS): SourceHealth {
  if (!input.connected) return 'disconnected';
  if (input.lastFrameAt === null || now - input.lastFrameAt > thresholdMs) return 'stalled';
  return 'live';
}

/** 健全性の一覧が同じか（ソースと状態がすべて一致）。 */
export function sameHealth(a: ReadonlyMap<string, SourceHealth>, b: ReadonlyMap<string, SourceHealth>): boolean {
  if (a.size !== b.size) return false;
  for (const [source, health] of a) if (b.get(source) !== health) return false;
  return true;
}

export const HEALTH_LABEL: Record<SourceHealth, string> = { live: '受信中', stalled: '映像途絶', disconnected: '未接続' };

const collator = new Intl.Collator('ja', { numeric: true });
/** 端末名の自然順（CAM2 < CAM10）で並べ、重複を除き上限で切る。 */
export function orderDevices(names: Iterable<string>, limit: number): string[] {
  return [...new Set(names)].sort(collator.compare).slice(0, limit);
}

/** マルチビューのカメラ枠。上限まで空き枠（null）で埋める。 */
export function cameraSlots(names: Iterable<string>, limit: number = MAX_CAMERAS): (string | null)[] {
  const ordered = orderDevices(names, limit);
  return Array.from({ length: limit }, (_, index) => ordered[index] ?? null);
}

/**
 * スライド共有の途絶警告（F-SHR-07）。一度でも受信した後に live でなくなったら警告する。
 * 返り値の seen を次回の入力に渡す。
 */
export function slideAlert(seen: boolean, health: SourceHealth): { seen: boolean; alert: boolean } {
  const nextSeen = seen || health === 'live';
  return { seen: nextSeen, alert: nextSeen && health !== 'live' };
}
