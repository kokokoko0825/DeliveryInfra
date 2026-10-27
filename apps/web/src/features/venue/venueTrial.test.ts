import { afterEach, describe, expect, it, vi } from 'vitest';
import { venueTrialId } from './venueTrial';

afterEach(() => { vi.unstubAllGlobals(); window.history.replaceState(null, '', '/'); });

describe('venueTrialId', () => {
  it('reads the shared trial ID from the device URL', () => {
    window.history.replaceState(null, '', '/venue/speaker?trialId=room_1');
    expect(venueTrialId()).toBe('room_1');
  });

  it('rejects values that cannot safely be embedded in run metadata', () => {
    window.history.replaceState(null, '', '/venue/speaker?trialId=room%20one');
    expect(venueTrialId()).toBeNull();
    window.history.replaceState(null, '', '/venue/speaker?trialId=' + 'a'.repeat(49));
    expect(venueTrialId()).toBeNull();
  });

  it('trims edge spaces and returns null when the parameter is absent', () => {
    window.history.replaceState(null, '', '/venue/speaker?trialId=%20room_2%20');
    expect(venueTrialId()).toBe('room_2');
    window.history.replaceState(null, '', '/venue/speaker');
    expect(venueTrialId()).toBeNull();
  });

  it('returns null when there is no browser location', () => {
    vi.stubGlobal('location', undefined);
    expect(venueTrialId()).toBeNull();
  });
});
