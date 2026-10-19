import { describe, expect, it } from 'vitest';
import { CornerSchema, PIP_MARGIN, PIP_SCALE, PROGRAM_FPS, PROGRAM_SIZE, PipSizeSchema, fitRect, pipRect } from './layout';

describe('pipRect', () => {
  it('places a 16:9 sub picture in each corner with a margin (1280x720)', () => {
    expect(pipRect('top-left', 'medium')).toEqual({ x: 32, y: 32, w: 422, h: 237 });
    expect(pipRect('top-right', 'medium')).toEqual({ x: 1280 - 32 - 422, y: 32, w: 422, h: 237 });
    expect(pipRect('bottom-left', 'medium')).toEqual({ x: 32, y: 720 - 32 - 237, w: 422, h: 237 });
    expect(pipRect('bottom-right', 'medium')).toEqual({ x: 826, y: 451, w: 422, h: 237 });
  });
  it('scales small / medium / large', () => {
    expect(pipRect('top-left', 'small')).toEqual({ x: 32, y: 32, w: 320, h: 180 });
    expect(pipRect('top-left', 'large')).toEqual({ x: 32, y: 32, w: 512, h: 288 });
    expect(PIP_SCALE).toEqual({ small: 0.25, medium: 0.33, large: 0.4 });
    expect(PIP_MARGIN).toBe(0.025);
  });
  it('works on other canvas sizes', () => {
    expect(pipRect('bottom-right', 'small', { width: 640, height: 360 })).toEqual({ x: 640 - 16 - 160, y: 360 - 16 - 90, w: 160, h: 90 });
  });
  it('program defaults are 1280x720@30', () => {
    expect(PROGRAM_SIZE).toEqual({ width: 1280, height: 720 });
    expect(PROGRAM_FPS).toBe(30);
  });
});

describe('PiP schemas', () => {
  it('accepts only the four corners and three sizes', () => {
    expect(CornerSchema.safeParse('top-left').success).toBe(true);
    expect(CornerSchema.safeParse('center').success).toBe(false);
    expect(PipSizeSchema.safeParse('large').success).toBe(true);
    expect(PipSizeSchema.safeParse('huge').success).toBe(false);
  });
});

describe('fitRect', () => {
  const target = { x: 0, y: 0, w: 1280, h: 720 };
  it('draws the full frame when ratios match', () => {
    expect(fitRect({ width: 1920, height: 1080 }, target, 'contain')).toEqual({ sx: 0, sy: 0, sw: 1920, sh: 1080, dx: 0, dy: 0, dw: 1280, dh: 720 });
    expect(fitRect({ width: 640, height: 360 }, target, 'cover')).toEqual({ sx: 0, sy: 0, sw: 640, sh: 360, dx: 0, dy: 0, dw: 1280, dh: 720 });
  });
  it('contain letterboxes a wider source and pillarboxes a taller one', () => {
    expect(fitRect({ width: 2000, height: 500 }, target, 'contain')).toEqual({ sx: 0, sy: 0, sw: 2000, sh: 500, dx: 0, dy: 200, dw: 1280, dh: 320 });
    expect(fitRect({ width: 720, height: 1280 }, target, 'contain')).toEqual({ sx: 0, sy: 0, sw: 720, sh: 1280, dx: 437.5, dy: 0, dw: 405, dh: 720 });
  });
  it('contain respects the target offset', () => {
    const offset = { x: 100, y: 50, w: 160, h: 90 };
    expect(fitRect({ width: 90, height: 160 }, offset, 'contain')).toEqual({ sx: 0, sy: 0, sw: 90, sh: 160, dx: 100 + (160 - 50.625) / 2, dy: 50, dw: 50.625, dh: 90 });
    expect(fitRect({ width: 400, height: 100 }, offset, 'contain')).toEqual({ sx: 0, sy: 0, sw: 400, sh: 100, dx: 100, dy: 50 + (90 - 40) / 2, dw: 160, dh: 40 });
  });
  it('cover crops the sides of a wider source and top/bottom of a taller one', () => {
    expect(fitRect({ width: 2000, height: 720 }, target, 'cover')).toEqual({ sx: 360, sy: 0, sw: 1280, sh: 720, dx: 0, dy: 0, dw: 1280, dh: 720 });
    expect(fitRect({ width: 720, height: 1280 }, target, 'cover')).toEqual({ sx: 0, sy: 437.5, sw: 720, sh: 405, dx: 0, dy: 0, dw: 1280, dh: 720 });
  });
  it('falls back to the full frame for empty sizes', () => {
    const full = (w: number, h: number, t = target) => ({ sx: 0, sy: 0, sw: w, sh: h, dx: t.x, dy: t.y, dw: t.w, dh: t.h });
    expect(fitRect({ width: 0, height: 720 }, target, 'cover')).toEqual(full(0, 720));
    expect(fitRect({ width: 1280, height: 0 }, target, 'cover')).toEqual(full(1280, 0));
    expect(fitRect({ width: 10, height: 10 }, { x: 0, y: 0, w: 0, h: 10 }, 'contain')).toEqual(full(10, 10, { x: 0, y: 0, w: 0, h: 10 }));
    expect(fitRect({ width: 10, height: 10 }, { x: 0, y: 0, w: 10, h: 0 }, 'contain')).toEqual(full(10, 10, { x: 0, y: 0, w: 10, h: 0 }));
  });
});
