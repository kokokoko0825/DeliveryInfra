/** プレビュー / プログラムの状態機械（純粋）。 */
import { DEFAULT_TRANSITION_SEC, TransitionDurationSchema, TransitionTypeSchema, transitionProgress, type TransitionType } from './transition';
import { STANDBY, sceneSources, validatePip, type PipSettings, type Scene, type SourceId } from './scene';

export type ActiveTransition = { from: Scene; to: Scene; type: Exclude<TransitionType, 'cut'>; startedAt: number; durationMs: number };
export type SwitcherState = {
  preview: Scene;
  program: Scene;
  transitionType: TransitionType;
  durationSec: number;
  active: ActiveTransition | null;
};

export type SwitcherAction =
  | { type: 'SELECT_PREVIEW'; source: SourceId }
  | { type: 'SET_PIP'; pip: PipSettings | null }
  | { type: 'SET_TRANSITION_TYPE'; transitionType: TransitionType }
  | { type: 'SET_DURATION'; seconds: number }
  | { type: 'CUT' }
  | { type: 'AUTO'; now: number }
  | { type: 'TICK'; now: number };

export const initialSwitcherState: SwitcherState = {
  preview: { main: STANDBY, pip: null },
  program: { main: STANDBY, pip: null },
  transitionType: 'dissolve',
  durationSec: DEFAULT_TRANSITION_SEC,
  active: null,
};

/** カット: プレビューとプログラムを入れ替える（次の画を選び直しやすいよう、直前の画がプレビューに戻る）。 */
const cut = (state: SwitcherState): SwitcherState => ({ ...state, program: state.preview, preview: state.program, active: null });

export function switcherReducer(state: SwitcherState, action: SwitcherAction): SwitcherState {
  switch (action.type) {
    case 'SELECT_PREVIEW': {
      // メインとサブが同じになる PiP は外す
      const pip = state.preview.pip && state.preview.pip.sub !== action.source ? state.preview.pip : null;
      return { ...state, preview: { main: action.source, pip } };
    }
    case 'SET_PIP': {
      if (action.pip === null) return { ...state, preview: { ...state.preview, pip: null } };
      const pip = validatePip(state.preview.main, action.pip);
      return pip ? { ...state, preview: { ...state.preview, pip } } : state;
    }
    case 'SET_TRANSITION_TYPE':
      return TransitionTypeSchema.safeParse(action.transitionType).success ? { ...state, transitionType: action.transitionType } : state;
    case 'SET_DURATION':
      return TransitionDurationSchema.safeParse(action.seconds).success ? { ...state, durationSec: action.seconds } : state;
    case 'CUT':
      return cut(state);
    case 'AUTO': {
      if (state.active) return state;
      if (state.transitionType === 'cut') return cut(state);
      return {
        ...state,
        active: { from: state.program, to: state.preview, type: state.transitionType, startedAt: action.now, durationMs: Math.round(state.durationSec * 1000) },
      };
    }
    case 'TICK': {
      const { active } = state;
      if (!active || transitionProgress(active.startedAt, active.durationMs, action.now) < 1) return state;
      // トランジション中にプレビューを選び直していたら、その選択を残す（R3-06）
      const previewChanged = state.preview !== active.to;
      return { ...state, program: active.to, preview: previewChanged ? state.preview : active.from, active: null };
    }
  }
}

/** 番組に出ている（トランジション中は前後どちらかに含まれる）ソース。 */
export function onAirSources(state: SwitcherState): Set<SourceId> {
  const scenes = state.active ? [state.active.from, state.active.to] : [state.program];
  return new Set(scenes.flatMap(sceneSources));
}
