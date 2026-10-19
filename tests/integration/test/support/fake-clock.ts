import { vi } from 'vitest';

/**
 * API は Date.now をハンドラ生成時(モジュール読み込み時)に捕捉するため、
 * 時刻を操作するテストはハンドラを import する前にこのモジュールを読み込む。
 */
vi.useFakeTimers({ toFake: ['Date'] });
