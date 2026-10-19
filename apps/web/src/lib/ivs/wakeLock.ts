/** Screen Wake Lock。画面が再表示されたら取り直す（非表示で自動解放されるため）。 */
export function holdWakeLock(): () => void {
  const nav = navigator as Navigator & { wakeLock?: { request: (type: 'screen') => Promise<{ release: () => Promise<void> }> } };
  if (!nav.wakeLock) return () => undefined;
  let sentinel: { release: () => Promise<void> } | null = null;
  let released = false;
  const acquire = () => {
    nav.wakeLock?.request('screen').then((lock) => {
      if (released) void lock.release();
      else sentinel = lock;
    }).catch(() => undefined);
  };
  const onVisible = () => { if (document.visibilityState === 'visible') acquire(); };
  acquire();
  document.addEventListener('visibilitychange', onVisible);
  return () => {
    released = true;
    document.removeEventListener('visibilitychange', onVisible);
    void sentinel?.release().catch(() => undefined);
    sentinel = null;
  };
}
