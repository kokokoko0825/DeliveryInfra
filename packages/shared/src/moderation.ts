export const COMMENT_RATE_LIMIT_MS = 3000;
export const COMMENT_HISTORY_LIMIT = 100;
/** 審査 Lambda の DENY 理由。IVS Chat が送信者への 406 の errorMessage に含めるので、Web はこの文言で出し分ける（R4-03）。 */
export const CHAT_DENY_REASONS = {
  displayNameMissing: '表示名を設定してください',
  suspended: 'コメントの送信が停止されています',
  ngWord: '使用できない単語が含まれています',
  rateLimited: 'コメントは3秒に1回まで送信できます',
} as const;

export const normalizeForModeration = (value: string): string => value.normalize('NFKC').toLocaleLowerCase('ja-JP');
export const containsNgWord = (value: string, words: readonly string[]): boolean => {
  const normalized = normalizeForModeration(value);
  return words.some((word) => word.length > 0 && normalized.includes(normalizeForModeration(word)));
};
