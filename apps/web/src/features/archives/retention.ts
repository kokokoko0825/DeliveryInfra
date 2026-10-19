import { z } from 'zod';
import { formatDate } from '@/lib/format';

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** ISO 日時 → 日本時間の日付（<input type="date"> 用 YYYY-MM-DD）。 */
export const toJstDate = (iso: string) => new Date(Date.parse(iso) + JST_OFFSET_MS).toISOString().slice(0, 10);

/** 日本時間の日付 → その日の終わり（23:59:59 JST）の ISO 日時。期限当日いっぱいは残す。 */
export const endOfJstDay = (date: string) => new Date(Date.parse(`${date}T23:59:59.000+09:00`)).toISOString();

/** 延長のみ受け付ける（現在の期限日より後の日付）。 */
export const retainUntilFormSchema = (current: string) => z.object({
  date: z.string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, '日付を選択してください')
    .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00+09:00`)), '日付を選択してください')
    .refine((value) => value > toJstDate(current), `${formatDate(current)} より後の日付を選択してください`),
});
