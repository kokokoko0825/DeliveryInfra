import { describe, expect, it } from 'vitest';
import { composeFrame, fitFor, sceneLayers } from './compose';
import { SLIDE, STANDBY, cameraSource, isCamera, sceneSources, sourceLabel, validatePip, type Scene } from './scene';
import { initialSwitcherState, onAirSources, switcherReducer, type SwitcherState } from './state';
import {
  DEFAULT_TRANSITION_SEC, TRANSITION_LABEL, TRANSITION_MAX_SEC, TRANSITION_MIN_SEC, TransitionDurationSchema, TransitionTypeSchema, ease, transitionProgress,
} from './transition';

const CAM1 = cameraSource('CAM1');
const CAM2 = cameraSource('CAM2');
const pip = { sub: CAM1, corner: 'bottom-right', size: 'small' } as const;

describe('transition', () => {
  it('validates duration 0.3〜2 seconds (boundaries)', () => {
    expect(TRANSITION_MIN_SEC).toBe(0.3);
    expect(TRANSITION_MAX_SEC).toBe(2);
    expect(DEFAULT_TRANSITION_SEC).toBe(0.5);
    expect(TransitionDurationSchema.safeParse(0.29).success).toBe(false);
    expect(TransitionDurationSchema.safeParse(0.3).success).toBe(true);
    expect(TransitionDurationSchema.safeParse(2).success).toBe(true);
    expect(TransitionDurationSchema.safeParse(2.01).success).toBe(false);
    expect(TransitionDurationSchema.safeParse(Number.NaN).success).toBe(false);
    expect(TransitionDurationSchema.safeParse(Number.POSITIVE_INFINITY).success).toBe(false);
  });
  it('validates transition types', () => {
    expect(TransitionTypeSchema.options).toEqual(['cut', 'dissolve', 'wipe']);
    expect(TransitionTypeSchema.safeParse('fade').success).toBe(false);
    expect(TRANSITION_LABEL).toEqual({ cut: 'カット', dissolve: 'ディゾルブ', wipe: 'ワイプ' });
  });
  it('progress is clamped to 0〜1', () => {
    expect(transitionProgress(1000, 500, 900)).toBe(0);
    expect(transitionProgress(1000, 500, 1000)).toBe(0);
    expect(transitionProgress(1000, 500, 1250)).toBe(0.5);
    expect(transitionProgress(1000, 500, 1500)).toBe(1);
    expect(transitionProgress(1000, 500, 9999)).toBe(1);
    expect(transitionProgress(1000, 0, 0)).toBe(1);
    expect(transitionProgress(1000, -5, 0)).toBe(1);
  });
  it('ease is a clamped smoothstep', () => {
    expect(ease(-1)).toBe(0);
    expect(ease(0)).toBe(0);
    expect(ease(0.25)).toBeCloseTo(0.15625);
    expect(ease(0.5)).toBe(0.5);
    expect(ease(1)).toBe(1);
    expect(ease(2)).toBe(1);
  });
});

describe('scene', () => {
  it('identifies sources and labels them', () => {
    expect(CAM1).toBe('camera:CAM1');
    expect(isCamera(CAM1)).toBe(true);
    expect(isCamera(SLIDE)).toBe(false);
    expect(sourceLabel(CAM1)).toBe('CAM1');
    expect(sourceLabel(SLIDE)).toBe('スライド');
    expect(sourceLabel(STANDBY)).toBe('待機画面');
  });
  it('validates PiP settings', () => {
    expect(validatePip(SLIDE, pip)).toEqual(pip);
    expect(validatePip(CAM1, pip)).toBeNull();
    expect(validatePip(SLIDE, { ...pip, corner: 'middle' })).toBeNull();
    expect(validatePip(SLIDE, { ...pip, size: 'xl' })).toBeNull();
    expect(validatePip(SLIDE, { ...pip, sub: 'camera:' })).toBeNull();
    expect(validatePip(SLIDE, { ...pip, sub: 'mic:MIC1' })).toBeNull();
    expect(validatePip(CAM1, { ...pip, sub: STANDBY })).toEqual({ ...pip, sub: STANDBY });
    expect(validatePip(CAM1, { ...pip, sub: SLIDE })).toEqual({ ...pip, sub: SLIDE });
    expect(validatePip(SLIDE, null)).toBeNull();
  });
  it('lists the sources of a scene', () => {
    const a: Scene = { main: SLIDE, pip };
    expect(sceneSources(a)).toEqual([SLIDE, CAM1]);
    expect(sceneSources({ main: CAM2, pip: null })).toEqual([CAM2]);
  });
});

describe('compose', () => {
  it('fits cameras with cover, slides and standby with contain', () => {
    expect(fitFor(CAM1)).toBe('cover');
    expect(fitFor(SLIDE)).toBe('contain');
    expect(fitFor(STANDBY)).toBe('contain');
  });
  it('builds main + PiP layers', () => {
    expect(sceneLayers({ main: SLIDE, pip: null })).toEqual([{ source: SLIDE, rect: { x: 0, y: 0, w: 1280, h: 720 }, fit: 'contain' }]);
    expect(sceneLayers({ main: SLIDE, pip })).toEqual([
      { source: SLIDE, rect: { x: 0, y: 0, w: 1280, h: 720 }, fit: 'contain' },
      { source: CAM1, rect: { x: 928, y: 508, w: 320, h: 180 }, fit: 'cover' },
    ]);
  });
  it('draws only the program when idle', () => {
    expect(composeFrame({ main: CAM1, pip: null }, null, 0)).toEqual([{ layers: sceneLayers({ main: CAM1, pip: null }), alpha: 1, clip: null }]);
  });
  it('dissolve overlays the next scene with eased alpha', () => {
    const active = { from: { main: CAM1, pip: null }, to: { main: CAM2, pip: null }, type: 'dissolve' as const, startedAt: 0, durationMs: 1000 };
    const frame = composeFrame({ main: CAM1, pip: null }, active, 500);
    expect(frame).toEqual([
      { layers: sceneLayers(active.from), alpha: 1, clip: null },
      { layers: sceneLayers(active.to), alpha: 0.5, clip: null },
    ]);
    expect(composeFrame(active.from, active, 250)[1]?.alpha).toBeCloseTo(0.15625);
  });
  it('wipe reveals the next scene from left to right', () => {
    const active = { from: { main: CAM1, pip: null }, to: { main: SLIDE, pip: null }, type: 'wipe' as const, startedAt: 100, durationMs: 1000 };
    expect(composeFrame(active.from, active, 600)).toEqual([
      { layers: sceneLayers(active.from), alpha: 1, clip: null },
      { layers: sceneLayers(active.to), alpha: 1, clip: { x: 0, y: 0, w: 640, h: 720 } },
    ]);
    expect(composeFrame(active.from, active, 1100)[1]?.clip?.w).toBe(1280);
    expect(composeFrame(active.from, active, 0)[1]?.clip?.w).toBe(0);
    expect(composeFrame(active.from, active, 600, { width: 100, height: 50 })[1]?.clip).toEqual({ x: 0, y: 0, w: 50, h: 50 });
  });
});

describe('switcherReducer', () => {
  const ready = (overrides: Partial<SwitcherState> = {}): SwitcherState => ({ ...initialSwitcherState, preview: { main: CAM1, pip: null }, program: { main: STANDBY, pip: null }, ...overrides });

  it('starts on the standby screen with dissolve 0.5s', () => {
    expect(initialSwitcherState).toEqual({ preview: { main: STANDBY, pip: null }, program: { main: STANDBY, pip: null }, transitionType: 'dissolve', durationSec: 0.5, active: null });
  });
  it('selects a preview source and keeps a compatible PiP', () => {
    const state = ready({ preview: { main: SLIDE, pip } });
    expect(switcherReducer(state, { type: 'SELECT_PREVIEW', source: STANDBY }).preview).toEqual({ main: STANDBY, pip });
    expect(switcherReducer(state, { type: 'SELECT_PREVIEW', source: CAM1 }).preview).toEqual({ main: CAM1, pip: null });
    expect(switcherReducer(ready(), { type: 'SELECT_PREVIEW', source: SLIDE }).preview).toEqual({ main: SLIDE, pip: null });
  });
  it('sets and clears a valid PiP, ignoring invalid ones', () => {
    const state = ready({ preview: { main: SLIDE, pip: null } });
    const withPip = switcherReducer(state, { type: 'SET_PIP', pip });
    expect(withPip.preview.pip).toEqual(pip);
    expect(switcherReducer(withPip, { type: 'SET_PIP', pip: null }).preview).toEqual({ main: SLIDE, pip: null });
    expect(switcherReducer(ready(), { type: 'SET_PIP', pip })).toEqual(ready());
    expect(switcherReducer(state, { type: 'SET_PIP', pip: { ...pip, corner: 'center' as never } })).toBe(state);
  });
  it('validates duration and transition type', () => {
    const state = ready();
    expect(switcherReducer(state, { type: 'SET_DURATION', seconds: 0.29 })).toBe(state);
    expect(switcherReducer(state, { type: 'SET_DURATION', seconds: 0.3 }).durationSec).toBe(0.3);
    expect(switcherReducer(state, { type: 'SET_DURATION', seconds: 2 }).durationSec).toBe(2);
    expect(switcherReducer(state, { type: 'SET_DURATION', seconds: 2.01 })).toBe(state);
    expect(switcherReducer(state, { type: 'SET_TRANSITION_TYPE', transitionType: 'wipe' }).transitionType).toBe('wipe');
    expect(switcherReducer(state, { type: 'SET_TRANSITION_TYPE', transitionType: 'spin' as never })).toBe(state);
  });
  it('CUT swaps preview and program immediately', () => {
    const next = switcherReducer(ready(), { type: 'CUT' });
    expect(next.program).toEqual({ main: CAM1, pip: null });
    expect(next.preview).toEqual({ main: STANDBY, pip: null });
    expect(next.active).toBeNull();
  });
  it('AUTO with cut type behaves like CUT', () => {
    expect(switcherReducer(ready({ transitionType: 'cut' }), { type: 'AUTO', now: 5 })).toEqual(switcherReducer(ready({ transitionType: 'cut' }), { type: 'CUT' }));
  });
  it('AUTO starts a transition, TICK completes it after the duration', () => {
    const started = switcherReducer(ready({ durationSec: 0.75, transitionType: 'wipe' }), { type: 'AUTO', now: 1000 });
    expect(started.active).toEqual({ from: { main: STANDBY, pip: null }, to: { main: CAM1, pip: null }, type: 'wipe', startedAt: 1000, durationMs: 750 });
    expect(started.program).toEqual({ main: STANDBY, pip: null });
    expect(switcherReducer(started, { type: 'AUTO', now: 1100 })).toBe(started);
    expect(switcherReducer(started, { type: 'TICK', now: 1749 })).toBe(started);
    const done = switcherReducer(started, { type: 'TICK', now: 1750 });
    expect(done.program).toEqual({ main: CAM1, pip: null });
    expect(done.preview).toEqual({ main: STANDBY, pip: null });
    expect(done.active).toBeNull();
    expect(switcherReducer(done, { type: 'TICK', now: 9999 })).toBe(done);
  });
  it('keeps a preview chosen during a transition when it completes (R3-06)', () => {
    const started = switcherReducer(ready({ durationSec: 2 }), { type: 'AUTO', now: 0 });
    const chosen = switcherReducer(started, { type: 'SELECT_PREVIEW', source: SLIDE });
    const done = switcherReducer(chosen, { type: 'TICK', now: 2000 });
    expect(done.program).toEqual({ main: CAM1, pip: null });
    expect(done.preview).toEqual({ main: SLIDE, pip: null });
    // PiP の変更も保持する
    const withPip = switcherReducer(switcherReducer(started, { type: 'SELECT_PREVIEW', source: SLIDE }), { type: 'SET_PIP', pip });
    expect(switcherReducer(withPip, { type: 'TICK', now: 2000 }).preview).toEqual({ main: SLIDE, pip });
    // 無効な PiP（変更なし）なら従来どおり直前の番組がプレビューに戻る
    const rejected = switcherReducer(started, { type: 'SET_PIP', pip: { ...pip, sub: CAM1 } });
    expect(switcherReducer(rejected, { type: 'TICK', now: 2000 }).preview).toEqual({ main: STANDBY, pip: null });
  });
  it('CUT during a transition finishes it at once', () => {
    const started = switcherReducer(ready(), { type: 'AUTO', now: 0 });
    const cut = switcherReducer(started, { type: 'CUT' });
    expect(cut.active).toBeNull();
    expect(cut.program).toEqual({ main: CAM1, pip: null });
  });
  it('onAirSources includes PiP and both sides of a transition', () => {
    expect([...onAirSources(ready({ program: { main: SLIDE, pip } }))]).toEqual([SLIDE, CAM1]);
    const started = switcherReducer(ready(), { type: 'AUTO', now: 0 });
    expect([...onAirSources(started)].sort()).toEqual([CAM1, STANDBY].sort());
  });
});
