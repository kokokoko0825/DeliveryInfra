/** キーボードショートカット（純粋）。 */
import { SLIDE, STANDBY, cameraSource, type SourceId } from './scene';

export type ShortcutAction = { type: 'SELECT_PREVIEW'; source: SourceId } | { type: 'CUT' } | { type: 'AUTO' };

/** 1〜6: カメラ枠、7: スライド、8: 待機画面、Space: カット、Enter: トランジション。 */
export const SHORTCUT_HELP = [
  ['1〜6', 'カメラをプレビュー'], ['7', 'スライドをプレビュー'], ['8', '待機画面をプレビュー'],
  ['Space', 'カット'], ['Enter', 'トランジション'],
] as const;

export function keyToAction(key: string, slots: readonly (string | null)[]): ShortcutAction | null {
  if (key === ' ' || key === 'Spacebar') return { type: 'CUT' };
  if (key === 'Enter') return { type: 'AUTO' };
  if (key === '7') return { type: 'SELECT_PREVIEW', source: SLIDE };
  if (key === '8') return { type: 'SELECT_PREVIEW', source: STANDBY };
  if (/^[1-6]$/.test(key)) {
    const name = slots[Number(key) - 1];
    return name ? { type: 'SELECT_PREVIEW', source: cameraSource(name) } : null;
  }
  return null;
}

export type KeyTarget = { tagName?: string; isContentEditable?: boolean; role?: string | null };
const TEXT_TAGS = ['INPUT', 'TEXTAREA', 'SELECT'];
const TEXT_ROLES = ['textbox', 'combobox', 'searchbox', 'spinbutton', 'slider'];
// SUMMARY は Enter/Space で details を開閉する（R3-05）
const ACTIVATING_TAGS = ['BUTTON', 'A', 'SUMMARY'];
const ACTIVATING_ROLES = ['button', 'link', 'switch', 'tab', 'radio', 'checkbox', 'menuitem', 'option'];

/** キー入力の対象として扱う要素。フォーカス要素の内側（例: summary 内の span）から最も近いものを選ぶ。 */
export const INTERACTIVE_SELECTOR = [
  ...TEXT_TAGS, ...ACTIVATING_TAGS, '[contenteditable="true"]',
  ...[...TEXT_ROLES, ...ACTIVATING_ROLES].map((role) => `[role="${role}"]`),
].join(',').toLowerCase();

/**
 * ショートカットを無効にする場面か。
 * 入力欄・スライダーでは全キー、ボタン等では Space/Enter のみ（部品自身の操作と二重にならないように）。
 */
export function shouldIgnoreKey(key: string, target: KeyTarget | null, modifiers: { ctrl: boolean; meta: boolean; alt: boolean }): boolean {
  if (modifiers.ctrl || modifiers.meta || modifiers.alt) return true;
  if (!target) return false;
  const tag = target.tagName?.toUpperCase() ?? '';
  const role = target.role ?? '';
  if (target.isContentEditable || TEXT_TAGS.includes(tag) || TEXT_ROLES.includes(role)) return true;
  const activating = ACTIVATING_TAGS.includes(tag) || ACTIVATING_ROLES.includes(role);
  return activating && (key === ' ' || key === 'Enter');
}
