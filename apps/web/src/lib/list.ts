/** index の要素を delta だけ移動した新しい配列を返す。範囲外なら元の配列をそのまま返す。 */
export function moveItem<T>(items: readonly T[], index: number, delta: number): readonly T[] {
  const target = index + delta;
  if (index < 0 || index >= items.length || target < 0 || target >= items.length) return items;
  const next = [...items];
  const [item] = next.splice(index, 1) as [T];
  next.splice(target, 0, item);
  return next;
}
