/** 配信の経過時間・配信前チェック（純粋）。 */
import type { z } from 'zod';
import { STAGE_NAMES, type StatusResponseSchema } from '@delivery/shared';

type StatusResponse = z.infer<typeof StatusResponseSchema>;

/** 経過時間を H:MM:SS で返す。開始前・不正値は 0:00:00。 */
export function formatElapsed(startedAt: string | null, now: number): string {
  const start = startedAt ? Date.parse(startedAt) : Number.NaN;
  const total = Number.isNaN(start) ? 0 : Math.max(0, Math.floor((now - start) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export type CheckItem = { id: string; label: string; ok: boolean; detail: string };

const STAGE_LABEL: Record<(typeof STAGE_NAMES)[number], string> = { production: '制作用ステージ', slide: 'スライド用ステージ', broadcast: '配信用ステージ' };

/** GET /api/status の結果を配信前チェック項目にする（F-OPS-02）。 */
export function preflightItems(status: StatusResponse): CheckItem[] {
  const stages = STAGE_NAMES.map((name) => {
    const found = status.stages.find((stage) => stage.name === name);
    return { id: name, label: STAGE_LABEL[name], ok: Boolean(found?.exists), detail: found ? (found.exists ? found.status ?? '利用可能' : '見つかりません') : '応答なし' };
  });
  const chat = { id: 'chat', label: 'コメント（Chat ルーム）', ok: status.chatRoom.exists, detail: status.chatRoom.exists ? status.chatRoom.status ?? '利用可能' : '見つかりません' };
  return [...stages, chat];
}

export const preflightReady = (items: CheckItem[]) => items.length > 0 && items.every((item) => item.ok);
