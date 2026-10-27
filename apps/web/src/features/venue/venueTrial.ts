/** Use the same ?trialId= value on each device to correlate exported runs. */
export function venueTrialId(): string | null {
  if (typeof location === 'undefined') return null;
  const value = new URLSearchParams(location.search).get('trialId')?.trim();
  return value && /^[A-Za-z0-9_-]{1,48}$/.test(value) ? value : null;
}
