/** トランジションの時間・進行（純粋関数）。 */
import { z } from 'zod';

export const TRANSITION_TYPES = ['cut', 'dissolve', 'wipe'] as const;
export type TransitionType = (typeof TRANSITION_TYPES)[number];
export const TRANSITION_MIN_SEC = 0.3;
export const TRANSITION_MAX_SEC = 2;
export const DEFAULT_TRANSITION_SEC = 0.5;

export const TransitionTypeSchema = z.enum(TRANSITION_TYPES);
export const TransitionDurationSchema = z.number().finite().min(TRANSITION_MIN_SEC).max(TRANSITION_MAX_SEC);

/** 開始時刻からの進行度 0〜1。 */
export function transitionProgress(startedAt: number, durationMs: number, now: number): number {
  if (durationMs <= 0) return 1;
  return Math.min(1, Math.max(0, (now - startedAt) / durationMs));
}

/** 控えめな加減速（smoothstep）。 */
export function ease(progress: number): number {
  const p = Math.min(1, Math.max(0, progress));
  return p * p * (3 - 2 * p);
}

export const TRANSITION_LABEL: Record<TransitionType, string> = { cut: 'カット', dissolve: 'ディゾルブ', wipe: 'ワイプ' };
