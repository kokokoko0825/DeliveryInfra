export const COMMENT_RATE_LIMIT_MS = 3000;
export const COMMENT_HISTORY_LIMIT = 100;

export const normalizeForModeration = (value: string): string => value.normalize('NFKC').toLocaleLowerCase('ja-JP');
export const containsNgWord = (value: string, words: readonly string[]): boolean => {
  const normalized = normalizeForModeration(value);
  return words.some((word) => word.length > 0 && normalized.includes(normalizeForModeration(word)));
};
