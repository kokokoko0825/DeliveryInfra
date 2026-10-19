/** 再接続の待ち時間（1秒から倍々、最大 30 秒）。 */
export const backoffMs = (attempt: number) => Math.min(1000 * 2 ** attempt, 30_000);
